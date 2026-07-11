package graph

import (
	"fmt"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// statusSummary is a short human-readable status shown on the node chip — kubectl's STATUS column
// for the kinds that have one. The per-kind helpers live below; health.go derives the colored
// Health enum from the same objects.
func statusSummary(obj runtime.Object) string {
	switch o := obj.(type) {
	case *corev1.Pod:
		return podStatusSummary(o)
	case *appsv1.Deployment:
		return deploymentStatus(o)
	case *appsv1.ReplicaSet:
		return fmt.Sprintf("%d/%d", o.Status.ReadyReplicas, desiredReplicas(o.Spec.Replicas))
	case *appsv1.StatefulSet:
		return fmt.Sprintf("%d/%d", o.Status.ReadyReplicas, desiredReplicas(o.Spec.Replicas))
	case *appsv1.DaemonSet:
		return fmt.Sprintf("%d/%d", o.Status.NumberReady, o.Status.DesiredNumberScheduled)
	case *corev1.Service:
		return string(o.Spec.Type) // ClusterIP / NodePort / LoadBalancer / ExternalName
	case *corev1.Node:
		return nodeStatusSummary(o)
	case *corev1.Namespace:
		return namespaceStatus(o)
	case *networkingv1.Ingress:
		return ingressStatus(o)
	case *corev1.PersistentVolumeClaim:
		return pvcStatus(o)
	case *corev1.PersistentVolume:
		return pvStatus(o)
	case *policyv1.PodDisruptionBudget:
		return pdbStatus(o)
	case *batchv1.Job:
		if o.Spec.Suspend != nil && *o.Spec.Suspend {
			return "Suspended"
		}
		completions := int32(1)
		if o.Spec.Completions != nil {
			completions = *o.Spec.Completions
		}
		return fmt.Sprintf("%d/%d", o.Status.Succeeded, completions)
	case *batchv1.CronJob:
		if o.Spec.Suspend != nil && *o.Spec.Suspend {
			return "Suspended"
		}
		return o.Spec.Schedule
	default:
		// A CustomResourceDefinition's status IS what it defines (Kind · Scope · versions) — far more
		// useful than its Established condition, and the answer to "what is this CRD for".
		if s := crdSummary(obj); s != "" {
			return s
		}
		// A PriorityClass's status IS its value + globalDefault — the preemption-debugging facts.
		if s := priorityClassSummary(obj); s != "" {
			return s
		}
		// An IngressClass's status IS its controller (+ default marker) — "who serves my Ingress".
		if s := ingressClassSummary(obj); s != "" {
			return s
		}
		// A StorageClass's status IS its provisioner (+ default marker) — what backs its volumes.
		if s := storageClassSummary(obj); s != "" {
			return s
		}
		// A Traefik Middleware's status IS what it does (rateLimit 10/s, forwardAuth → …) — the answer
		// to "I see 'via ratelimit' on a route, what is that?".
		if s := traefikMiddlewareSummary(obj); s != "" {
			return s
		}
		// An admission webhook config's status IS its webhook count + fail policy — a Fail webhook whose
		// backend is down blocks matching API ops, the classic cluster outage worth surfacing.
		if s := webhookConfigSummary(obj); s != "" {
			return s
		}
		// Custom resources: a kind-specific status string (Workflow phase, Elasticsearch color,
		// Gateway attach state) when kd has a rule, else "unknown state" for an uninterpretable
		// CR and silence for a healthy-by-existence one. See crStatusSummary in health_cr.go.
		if IsUnstructuredCR(obj) {
			return crStatusSummary(obj.(*unstructured.Unstructured))
		}
		return ""
	}
}

// maxStatusMessage bounds the surfaced message so a pathological multi-KB status can't bloat the
// graph payload (and the SSE diff). The drawer truncates it for display anyway; this just caps what
// crosses the wire. Rune-based so it never splits a multibyte character.
const maxStatusMessage = 300

// statusMessage surfaces the one-line WHY behind an unhealthy resource — the failure reason that
// otherwise hides in the manifest's status, so an operator triaging a Degraded/Failed resource sees it
// in the drawer instead of opening the raw YAML. Only populated for non-Healthy resources: a healthy
// one has no "why" worth the payload, and surfacing one would be noise. Sources by kind: a CR's
// status.message (Argo Workflow/Rollout failures and many controllers write it there); a Pod's blocking
// condition message (the Unschedulable detail the per-container statuses can't carry); a Deployment's
// degraded-condition message (a rollout/replica failure). Other kinds carry their "why" elsewhere
// (container statuses, events) and return "".
func statusMessage(obj runtime.Object, h Health) string {
	if h == HealthHealthy {
		return ""
	}
	var msg string
	switch o := obj.(type) {
	case *unstructured.Unstructured:
		// Prefer a top-level status.message, but most controllers carry the "why" of a degraded CR in
		// conditions[].message (a Certificate, an ExternalSecret), so fall back to that.
		msg, _, _ = unstructured.NestedString(o.Object, "status", "message")
		// An Argo Workflow's top-level message is a propagation pointer ("child '<id>' failed") naming
		// a node the operator can't act on; drill into status.nodes for the failed leaf step's real
		// error. Falls through to the pointer/conditions when no leaf message exists.
		if leaf := argoWorkflowMessage(o); leaf != "" {
			msg = leaf
		} else if msg == "" {
			// HPAs carry their fault in ScalingActive/AbleToScale, not Ready/Available — match the
			// condition selection to hpaHealth's verdict.
			if o.GroupVersionKind().Group == "autoscaling" {
				msg = hpaConditionMessage(o)
			} else {
				msg = crConditionMessage(o)
			}
		}
	case *corev1.Pod:
		msg = blockingConditionMessage(o.Status.Conditions)
		// A terminally-failed pod's explanation lives in pod-level status.message — kubelet writes
		// the eviction cause there ("The node was low on resource: memory. Container x was using …").
		// The card shows the bare status.reason ("Evicted"); without this, the WHY stayed in the
		// manifest. Conditions win when present — they carry scheduling detail this duplicates.
		if msg == "" && o.Status.Message != "" {
			msg = o.Status.Message
		}
		// A pod stuck Terminating past its grace period shows nothing actionable anywhere — the
		// finalizer holding it lives only in the manifest. Wins over the blocking condition: while
		// deleting, "containers with unready status" is mechanics, the finalizer is the cause.
		if o.DeletionTimestamp != nil && len(o.Finalizers) > 0 {
			msg = "Deleting — waiting for finalizer " + strings.Join(o.Finalizers, ", ") + " to be removed by its controller"
		}
	case *appsv1.Deployment:
		msg = deploymentProblemMessage(o)
	case *appsv1.ReplicaSet:
		// ReplicaFailure is the only condition the RS controller writes; it names the creation-failure
		// cause (quota, admission) for the red RS card next to the red Deployment.
		for _, c := range o.Status.Conditions {
			if c.Type == appsv1.ReplicaSetReplicaFailure && c.Status == corev1.ConditionTrue {
				msg = c.Message
				break
			}
		}
	case *batchv1.Job:
		// The Failed condition's message ("Job has reached the specified backoff limit", "Job was
		// active longer than specified deadline") tells the operator the Job has terminally given up
		// — fix and re-create, don't wait — which "0/1 · failed 2" alone doesn't.
		for _, c := range o.Status.Conditions {
			if c.Type == batchv1.JobFailed && c.Status == corev1.ConditionTrue && c.Message != "" {
				msg = c.Message
				break
			}
		}
	case *policyv1.PodDisruptionBudget:
		msg = pdbBlockMessage(o)
	case *corev1.PersistentVolume:
		// A Released volume still references its DELETED claim, which silently blocks any new claim
		// from binding — the "why won't my new PVC take this volume" trap. Name the stale claim and
		// the way out.
		if o.Status.Phase == corev1.VolumeReleased && o.Spec.ClaimRef != nil {
			msg = fmt.Sprintf("Still references its deleted claim %s/%s — clear spec.claimRef to let a new claim bind, or delete the volume",
				o.Spec.ClaimRef.Namespace, o.Spec.ClaimRef.Name)
		}
	}
	return truncateRunes(strings.TrimSpace(msg), maxStatusMessage)
}

// blockingConditionMessage returns the message of the first pod condition that isn't satisfied (e.g. a
// False PodScheduled carrying "0/3 nodes are available: 3 Insufficient cpu") — the scheduling/readiness
// reason that the container statuses don't express. ContainersNotReady is skipped: its "containers
// with unready status: [x]" restates what the status summary (CrashLoopBackOff, Running 0/1) and the
// per-container cards already say better.
func blockingConditionMessage(conds []corev1.PodCondition) string {
	for _, c := range conds {
		if c.Status != corev1.ConditionTrue && c.Message != "" && c.Reason != "ContainersNotReady" {
			return c.Message
		}
	}
	return ""
}

// deploymentProblemMessage returns the explanatory message of a Deployment's degraded condition,
// ranked by how much each explains — array order is meaningless and repeatedly picked the wrong one:
//
//  1. ReplicaFailure=True — the actual creation-failure cause (quota exceeded, admission denial).
//  2. Any other False condition except Available — e.g. Progressing=False/ProgressDeadlineExceeded's
//     "ReplicaSet … has timed out progressing", which at least says the rollout gave up.
//  3. Available=False last: its "does not have minimum availability" is a tautology restating the
//     replica count the card already shows (kept only for Deployments where it's the sole message).
func deploymentProblemMessage(d *appsv1.Deployment) string {
	for _, c := range d.Status.Conditions {
		if c.Type == appsv1.DeploymentReplicaFailure && c.Status == corev1.ConditionTrue && c.Message != "" {
			return c.Message
		}
	}
	var availableMsg string
	for _, c := range d.Status.Conditions {
		if c.Type == appsv1.DeploymentReplicaFailure || c.Status != corev1.ConditionFalse || c.Message == "" {
			continue
		}
		if c.Type == appsv1.DeploymentAvailable {
			availableMsg = c.Message
			continue
		}
		return c.Message
	}
	return availableMsg
}

// pdbBlockMessage explains WHY a degraded PDB allows no voluntary disruptions — the DisruptionAllowed
// condition's message (or its reason when the message is empty). The drawer already flags "can disrupt
// 0"; this says which kind of 0 it is, because the two diverge sharply for the operator: the workload
// sitting below its floor (InsufficientPods — scale up before draining) reads nothing like the
// controller being unable to evaluate the budget at all (SyncFailed, e.g. a guarded pod's owner lacks
// the scale subresource — the PDB is misconfigured and a drain will block indefinitely).
func pdbBlockMessage(p *policyv1.PodDisruptionBudget) string {
	for _, c := range p.Status.Conditions {
		if c.Type == policyv1.DisruptionAllowedCondition && c.Status == metav1.ConditionFalse {
			if c.Message != "" {
				return c.Message
			}
			return c.Reason
		}
	}
	return ""
}

// truncateRunes caps s to max runes, appending an ellipsis when it cuts — rune-safe so it never splits
// a multibyte character.
func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}

// podStatusSummary mirrors kubectl's STATUS column: a waiting/terminated container reason
// (CrashLoopBackOff, ImagePullBackOff, OOMKilled, ...) is far more useful than the bare phase,
// which stays "Running" even while a container crash-loops. Deletion shows as Terminating.
func podStatusSummary(p *corev1.Pod) string {
	if p.DeletionTimestamp != nil {
		return "Terminating"
	}
	// Init containers run (sequentially) before the app ones; a failing init is what's actually wrong,
	// so surface it as kubectl does ("Init:CrashLoopBackOff") rather than the bare "Pending".
	for _, cs := range p.Status.InitContainerStatuses {
		if w := cs.State.Waiting; w != nil && isFailureReason(w.Reason) {
			return "Init:" + w.Reason
		}
		if t := cs.State.Terminated; t != nil && t.ExitCode != 0 && t.Reason != "" {
			return "Init:" + t.Reason
		}
	}
	for _, cs := range p.Status.ContainerStatuses {
		if w := cs.State.Waiting; w != nil && w.Reason != "" {
			return w.Reason
		}
	}
	for _, cs := range p.Status.ContainerStatuses {
		if t := cs.State.Terminated; t != nil && t.Reason != "" && t.Reason != "Completed" {
			return t.Reason
		}
	}
	if p.Status.Reason != "" {
		return p.Status.Reason // pod-level, e.g. Evicted, NodeAffinity
	}
	// A pod stuck Pending because the scheduler can't place it has NO container statuses to explain why,
	// so it would otherwise read a bare "Pending". Surface the PodScheduled condition's reason
	// (Unschedulable, SchedulerError) — the single most common "why won't my pod run" answer, which is
	// otherwise buried in status.conditions.
	if p.Status.Phase == corev1.PodPending {
		for _, c := range p.Status.Conditions {
			if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse && c.Reason != "" {
				return c.Reason
			}
		}
	}
	// A Running pod with some container not yet ready is up but not serving; show ready/total so
	// "up but failing readiness" is distinguishable from a healthy Running.
	if p.Status.Phase == corev1.PodRunning {
		ready, total := 0, len(p.Status.ContainerStatuses)
		for _, cs := range p.Status.ContainerStatuses {
			if cs.Ready {
				ready++
			}
		}
		if total > 0 && ready < total {
			return fmt.Sprintf("Running %d/%d", ready, total)
		}
	}
	return string(p.Status.Phase)
}

// deploymentStatus is the ready/desired count, except in the two states that count hides: a paused
// rollout reads "Paused" and an abandoned one (progress deadline exceeded) reads "rollout failed",
// so the chip explains a non-green border instead of showing a healthy-looking "3/3" in red/grey.
func deploymentStatus(d *appsv1.Deployment) string {
	if d.Spec.Paused {
		return "Paused"
	}
	for _, c := range d.Status.Conditions {
		if c.Type == appsv1.DeploymentProgressing && c.Status == corev1.ConditionFalse && c.Reason == "ProgressDeadlineExceeded" {
			return "rollout failed"
		}
	}
	return fmt.Sprintf("%d/%d", d.Status.ReadyReplicas, desiredReplicas(d.Spec.Replicas))
}

// nodeStatusSummary mirrors kubectl's node STATUS (Ready/NotReady, plus ,SchedulingDisabled when the
// node is cordoned), then appends the *why* behind a non-green health dot so the status text never
// silently contradicts the colour (the matching problem podStatusSummary solves): an otherwise-Ready
// node under resource pressure carries the active pressure(s) ("Ready · DiskPressure"), while a
// NotReady node carries its NodeReady reason ("NotReady · KubeletNotReady"). nodeHealth already paints
// the dot Degraded for both, but the cause is otherwise buried in status.conditions.
func nodeStatusSummary(n *corev1.Node) string {
	ready := false
	var notReadyReason string
	var pressures []string
	for _, c := range n.Status.Conditions {
		switch c.Type {
		case corev1.NodeReady:
			ready = c.Status == corev1.ConditionTrue
			if !ready {
				notReadyReason = c.Reason
			}
		case corev1.NodeMemoryPressure, corev1.NodeDiskPressure, corev1.NodePIDPressure:
			if c.Status == corev1.ConditionTrue {
				pressures = append(pressures, string(c.Type))
			}
		}
	}
	status := "NotReady"
	if ready {
		status = "Ready"
	}
	if n.Spec.Unschedulable {
		status += ",SchedulingDisabled"
	}
	if ready && len(pressures) > 0 {
		status += " · " + strings.Join(pressures, ", ")
	} else if !ready && notReadyReason != "" {
		status += " · " + notReadyReason
	}
	return status
}

// ingressStatus shows an Ingress's distinct hostnames so the network view says what URL routes
// where: the single host, "host +N" when there are several, or "*" for a host-less catch-all.
func ingressStatus(ing *networkingv1.Ingress) string {
	seen := map[string]bool{}
	var hosts []string
	for _, r := range ing.Spec.Rules {
		if r.Host != "" && !seen[r.Host] {
			seen[r.Host] = true
			hosts = append(hosts, r.Host)
		}
	}
	switch {
	case len(hosts) == 0:
		return "*"
	case len(hosts) == 1:
		return hosts[0]
	default:
		return fmt.Sprintf("%s +%d", hosts[0], len(hosts)-1)
	}
}

// pdbStatus shows the "current/floor" fraction ONLY when the budget is in deficit (fewer healthy than
// the desiredHealthy floor), where it reads as the shortfall it is ("6/8 healthy"). When the budget is
// satisfied it shows just the count ("2 healthy"). The fraction was previously shown always, to mirror
// the replica "ready/desired" form — but that mirror inverts: replicas have ready ≤ desired (approaching
// a target), a PDB has current ≥ floor, so a satisfied "2/1 healthy" read as an impossible "2 of 1". The
// spare headroom a satisfied fraction conveyed is already on the drawer's "can disrupt N" chip, so the
// count alone loses nothing. (A 0 floor likewise never produces a fraction here.)
func pdbStatus(p *policyv1.PodDisruptionBudget) string {
	if p.Status.CurrentHealthy < p.Status.DesiredHealthy {
		return fmt.Sprintf("%d/%d healthy", p.Status.CurrentHealthy, p.Status.DesiredHealthy)
	}
	return fmt.Sprintf("%d healthy", p.Status.CurrentHealthy)
}

// pvcStatus shows the claim phase plus the bound capacity when known (e.g. "Bound 10Gi"), the
// at-a-glance answer to "did my storage actually provision, and how big?".
func pvcStatus(p *corev1.PersistentVolumeClaim) string {
	return phaseWithCapacity(string(p.Status.Phase), p.Status.Capacity)
}

// pvStatus shows the volume phase plus its capacity (e.g. "Bound 10Gi"), symmetric to pvcStatus.
func pvStatus(p *corev1.PersistentVolume) string {
	return phaseWithCapacity(string(p.Status.Phase), p.Spec.Capacity)
}

// phaseWithCapacity is the shared PVC/PV formatter. Zero capacity is dropped — an unbound claim reports
// 0, and "Pending" alone reads truer than "Pending 0"; an empty phase yields "" (no status known yet).
func phaseWithCapacity(phase string, capacity corev1.ResourceList) string {
	if phase == "" {
		return ""
	}
	if q, ok := capacity[corev1.ResourceStorage]; ok && !q.IsZero() {
		return phase + " " + q.String()
	}
	return phase
}
