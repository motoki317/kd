package graph

import (
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// health normalizes a resource's status into the shared Health enum. Resources without
// meaningful runtime health (ConfigMap, Service, ...) report Healthy by existing.
func health(obj runtime.Object) Health {
	switch o := obj.(type) {
	case *corev1.Pod:
		return podHealth(o)
	case *appsv1.Deployment:
		return replicaHealth(o.Status.Replicas, o.Status.ReadyReplicas, o.Status.UpdatedReplicas, desiredReplicas(o.Spec.Replicas), o.Spec.Paused)
	case *appsv1.ReplicaSet:
		return replicaHealth(o.Status.Replicas, o.Status.ReadyReplicas, o.Status.ReadyReplicas, desiredReplicas(o.Spec.Replicas), false)
	case *appsv1.StatefulSet:
		return replicaHealth(o.Status.Replicas, o.Status.ReadyReplicas, o.Status.UpdatedReplicas, desiredReplicas(o.Spec.Replicas), false)
	case *appsv1.DaemonSet:
		return daemonSetHealth(o)
	case *batchv1.Job:
		return jobHealth(o)
	case *batchv1.CronJob:
		if o.Spec.Suspend != nil && *o.Spec.Suspend {
			return HealthSuspended // matches the "Suspended" status text and paused-Deployment handling
		}
		return HealthHealthy
	case *corev1.Node:
		return nodeHealth(o)
	default:
		return HealthHealthy
	}
}

// nodeHealth reads a Node's conditions: Ready=False (or missing) is Degraded, as is any resource
// pressure (Memory/Disk/PID); otherwise Healthy. Without this a NotReady node renders green.
func nodeHealth(n *corev1.Node) Health {
	ready := false
	for _, c := range n.Status.Conditions {
		switch c.Type {
		case corev1.NodeReady:
			ready = c.Status == corev1.ConditionTrue
		case corev1.NodeMemoryPressure, corev1.NodeDiskPressure, corev1.NodePIDPressure:
			if c.Status == corev1.ConditionTrue {
				return HealthDegraded
			}
		}
	}
	if !ready {
		return HealthDegraded
	}
	return HealthHealthy
}

func podHealth(p *corev1.Pod) Health {
	// A failing init container blocks the pod from ever starting, so it's degraded too.
	for _, cs := range p.Status.InitContainerStatuses {
		if w := cs.State.Waiting; w != nil && isFailureReason(w.Reason) {
			return HealthDegraded
		}
	}
	// A container stuck waiting (CrashLoopBackOff, ImagePullBackOff, ...) is degraded.
	for _, cs := range p.Status.ContainerStatuses {
		if w := cs.State.Waiting; w != nil && isFailureReason(w.Reason) {
			return HealthDegraded
		}
	}
	switch p.Status.Phase {
	case corev1.PodSucceeded:
		return HealthHealthy
	case corev1.PodFailed:
		return HealthDegraded
	case corev1.PodRunning:
		if podReady(p) {
			return HealthHealthy
		}
		return HealthProgressing
	case corev1.PodPending:
		return HealthProgressing
	default:
		return HealthUnknown
	}
}

func podReady(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func isFailureReason(reason string) bool {
	switch reason {
	case "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerError", "CreateContainerConfigError", "RunContainerError":
		return true
	default:
		return false
	}
}

func replicaHealth(current, ready, updated, desired int32, paused bool) Health {
	if paused {
		return HealthSuspended
	}
	if desired == 0 {
		return HealthHealthy
	}
	if ready >= desired && updated >= desired && current == desired {
		return HealthHealthy
	}
	if ready == 0 {
		return HealthDegraded
	}
	return HealthProgressing
}

func daemonSetHealth(d *appsv1.DaemonSet) Health {
	desired := d.Status.DesiredNumberScheduled
	if desired == 0 {
		return HealthHealthy
	}
	if d.Status.NumberReady >= desired && d.Status.UpdatedNumberScheduled >= desired {
		return HealthHealthy
	}
	if d.Status.NumberReady == 0 {
		return HealthDegraded
	}
	return HealthProgressing
}

func jobHealth(j *batchv1.Job) Health {
	for _, c := range j.Status.Conditions {
		if c.Status != corev1.ConditionTrue {
			continue
		}
		switch c.Type {
		case batchv1.JobComplete:
			return HealthHealthy
		case batchv1.JobFailed:
			return HealthDegraded
		}
	}
	// A suspended Job is intentionally paused, not unhealthy — treat it like a paused
	// Deployment or suspended CronJob rather than the Progressing fallthrough.
	if j.Spec.Suspend != nil && *j.Spec.Suspend {
		return HealthSuspended
	}
	return HealthProgressing
}

func desiredReplicas(r *int32) int32 {
	if r == nil {
		return 1
	}
	return *r
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

// podRestarts totals a pod's container restarts (0 for non-pods), the at-a-glance crash signal a
// "Running" status alone hides.
func podRestarts(obj runtime.Object) int32 {
	p, ok := obj.(*corev1.Pod)
	if !ok {
		return 0
	}
	var n int32
	for _, cs := range p.Status.ContainerStatuses {
		n += cs.RestartCount
	}
	return n
}

// containerNames lists a pod's container names (nil for non-pods), so the client can offer a
// per-container log picker for multi-container pods (sidecars, init wrappers).
func containerNames(obj runtime.Object) []string {
	p, ok := obj.(*corev1.Pod)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(p.Spec.Containers))
	for _, c := range p.Spec.Containers {
		names = append(names, c.Name)
	}
	return names
}

// containerStatuses condenses a pod's per-container runtime state (init containers first, then app
// containers), nil for non-pods. It's the "which container is actually broken" detail an aggregate
// restart count or phase hides.
func containerStatuses(obj runtime.Object) []ContainerStatus {
	p, ok := obj.(*corev1.Pod)
	if !ok {
		return nil
	}
	out := make([]ContainerStatus, 0, len(p.Status.InitContainerStatuses)+len(p.Status.ContainerStatuses))
	for _, cs := range p.Status.InitContainerStatuses {
		out = append(out, containerStat(cs, true))
	}
	for _, cs := range p.Status.ContainerStatuses {
		out = append(out, containerStat(cs, false))
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func containerStat(cs corev1.ContainerStatus, init bool) ContainerStatus {
	return ContainerStatus{Name: cs.Name, Ready: cs.Ready, Restarts: cs.RestartCount, State: containerStateString(cs.State), Init: init}
}

// containerStateString renders a container's current state as "Running", "Waiting: <reason>", or
// "Terminated: <reason>" — the reason is the actionable part (CrashLoopBackOff, OOMKilled, ...).
func containerStateString(s corev1.ContainerState) string {
	switch {
	case s.Running != nil:
		return "Running"
	case s.Waiting != nil:
		if s.Waiting.Reason != "" {
			return "Waiting: " + s.Waiting.Reason
		}
		return "Waiting"
	case s.Terminated != nil:
		if s.Terminated.Reason != "" {
			return "Terminated: " + s.Terminated.Reason
		}
		return "Terminated"
	default:
		return "Unknown"
	}
}

// containerImages lists the distinct images a resource runs — its own containers for a Pod, its
// pod template's for a workload — answering "what's actually deployed here" without opening the
// manifest. Distinct (a multi-replica template repeats the same image) and nil for resources
// without a pod spec.
func containerImages(obj runtime.Object) []string {
	spec := podSpecOf(obj)
	if spec == nil {
		return nil
	}
	var images []string
	seen := map[string]bool{}
	for _, c := range spec.Containers {
		if c.Image != "" && !seen[c.Image] {
			seen[c.Image] = true
			images = append(images, c.Image)
		}
	}
	return images
}

// podSpecOf returns the PodSpec a resource manages (its own for a Pod, its template's for a
// workload), or nil for resources without one.
func podSpecOf(obj runtime.Object) *corev1.PodSpec {
	switch o := obj.(type) {
	case *corev1.Pod:
		return &o.Spec
	case *appsv1.Deployment:
		return &o.Spec.Template.Spec
	case *appsv1.ReplicaSet:
		return &o.Spec.Template.Spec
	case *appsv1.StatefulSet:
		return &o.Spec.Template.Spec
	case *appsv1.DaemonSet:
		return &o.Spec.Template.Spec
	case *batchv1.Job:
		return &o.Spec.Template.Spec
	case *batchv1.CronJob:
		return &o.Spec.JobTemplate.Spec.Template.Spec
	default:
		return nil
	}
}

// nodeStatusSummary mirrors kubectl's node STATUS: Ready/NotReady, plus ,SchedulingDisabled when the
// node is cordoned.
func nodeStatusSummary(n *corev1.Node) string {
	status := "NotReady"
	for _, c := range n.Status.Conditions {
		if c.Type == corev1.NodeReady && c.Status == corev1.ConditionTrue {
			status = "Ready"
		}
	}
	if n.Spec.Unschedulable {
		status += ",SchedulingDisabled"
	}
	return status
}

// podHost returns the node a pod is scheduled on ("" for non-pods or unscheduled pods), placement
// context the operator otherwise has to dig out of the manifest.
func podHost(obj runtime.Object) string {
	if p, ok := obj.(*corev1.Pod); ok {
		return p.Spec.NodeName
	}
	return ""
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

// statusSummary is a short human-readable status shown on the node chip.
func statusSummary(obj runtime.Object) string {
	switch o := obj.(type) {
	case *corev1.Pod:
		return podStatusSummary(o)
	case *appsv1.Deployment:
		return fmt.Sprintf("%d/%d", o.Status.ReadyReplicas, desiredReplicas(o.Spec.Replicas))
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
	case *networkingv1.Ingress:
		return ingressStatus(o)
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
		return ""
	}
}
