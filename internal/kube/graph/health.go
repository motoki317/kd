package graph

import (
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// health normalizes a resource's status into the shared Health enum. Resources without
// meaningful runtime health (ConfigMap, Service, ...) report Healthy by existing. The
// human-readable status text lives in status.go; Node display fields in fields.go.
func health(obj runtime.Object) Health {
	switch o := obj.(type) {
	case *corev1.Pod:
		return podHealth(o)
	case *appsv1.Deployment:
		return deploymentHealth(o)
	case *appsv1.ReplicaSet:
		return replicaSetHealth(o)
	case *appsv1.StatefulSet:
		return replicaHealth(o.Status.Replicas, o.Status.ReadyReplicas, o.Status.UpdatedReplicas, desiredReplicas(o.Spec.Replicas))
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
	case *corev1.Namespace:
		return namespaceHealth(o)
	case *corev1.PersistentVolumeClaim:
		return pvcHealth(o)
	case *corev1.PersistentVolume:
		return pvHealth(o)
	case *policyv1.PodDisruptionBudget:
		return pdbHealth(o)
	case *unstructured.Unstructured:
		return crHealth(o)
	default:
		return HealthHealthy
	}
}

// namespaceHealth flags a Terminating namespace as Progressing — deletion is a transient state, but a
// namespace that lingers in it (blocked by a finalizer or an undeletable resource — the classic "stuck
// namespace") is exactly what an operator hunts for, so it should not read as a calm green Active. An
// Active namespace is healthy by existence.
func namespaceHealth(n *corev1.Namespace) Health {
	if n.Status.Phase == corev1.NamespaceTerminating || n.DeletionTimestamp != nil {
		return HealthProgressing
	}
	return HealthHealthy
}

// namespaceStatus surfaces a namespace's phase as kubectl's STATUS column does — "Terminating" while
// it's being deleted, "" for a healthy Active namespace (silent, since every namespace is normally
// Active and a constant "Active" badge would be noise).
func namespaceStatus(n *corev1.Namespace) string {
	if n.Status.Phase == corev1.NamespaceTerminating || n.DeletionTimestamp != nil {
		return "Terminating"
	}
	return ""
}

// pvHealth mirrors pvcHealth for the backing volume: Available (unbound) is healthy (it exists and is
// ready for a PVC to claim it), Bound (claimed) is healthy, Failed means the recycler/reclaimer
// failed (Degraded). Released splits on reclaim policy: with Delete the controller is about to remove
// it (Progressing, genuinely transient); with Retain it sits until an OPERATOR acts — clearing
// claimRef or deleting it — so blue "in progress" would promise motion that never comes (amber
// Suspended: paused awaiting a human, like a suspended CronJob).
func pvHealth(p *corev1.PersistentVolume) Health {
	switch p.Status.Phase {
	case corev1.VolumeAvailable, corev1.VolumeBound:
		return HealthHealthy
	case corev1.VolumeReleased:
		if p.Spec.PersistentVolumeReclaimPolicy == corev1.PersistentVolumeReclaimRetain {
			return HealthSuspended
		}
		return HealthProgressing
	case corev1.VolumeFailed:
		return HealthDegraded
	default:
		return HealthUnknown
	}
}

// pvcHealth follows the claim phase: Bound is healthy, Pending is still binding (and blocks the pods
// that mount it, so it's Progressing not green), Lost means the backing volume vanished (Degraded).
func pvcHealth(p *corev1.PersistentVolumeClaim) Health {
	switch p.Status.Phase {
	case corev1.ClaimBound:
		return HealthHealthy
	case corev1.ClaimPending:
		return HealthProgressing
	case corev1.ClaimLost:
		return HealthDegraded
	default:
		return HealthUnknown
	}
}

// pdbHealth keys on whether the protected workload meets the budget's floor: currentHealthy below
// desiredHealthy means the app is under its required minimum (and voluntary disruptions are blocked) —
// Degraded; at or above the floor it's Healthy. We deliberately do NOT key on disruptionsAllowed / the
// DisruptionAllowed condition: that goes False for benign reasons too (a PDB targeting pods whose
// controller lacks the scale subresource reports SyncFailed though the workload itself is fine), so it
// would false-alarm. Before this rule PDBs fell through to the CR heuristic and read "Unknown" — noise
// in the health tally that also hid genuinely-violated budgets.
func pdbHealth(p *policyv1.PodDisruptionBudget) Health {
	if p.Status.CurrentHealthy < p.Status.DesiredHealthy {
		return HealthDegraded
	}
	return HealthHealthy
}

// nodeHealth reads a Node's conditions: Ready=False (or missing) is Degraded, as is any resource
// pressure (Memory/Disk/PID). A cordoned (unschedulable) but otherwise-Ready node is Suspended — an
// intentional hold for drain/maintenance, surfaced like a paused Deployment so it stands out from
// green without alarming, while a real fault above still takes precedence. Otherwise Healthy.
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
	if n.Spec.Unschedulable {
		return HealthSuspended
	}
	return HealthHealthy
}

func podHealth(p *corev1.Pod) Health {
	// Succeeded wins before any container inspection: an Argo Workflow step pod reports phase
	// Succeeded even when its main container exited non-zero (the wait sidecar completes the
	// pod) — that failure belongs to the Workflow's health, not the finished pod.
	if p.Status.Phase == corev1.PodSucceeded {
		return HealthHealthy
	}
	// A failing init container blocks the pod from ever starting, so it's degraded too.
	for _, cs := range p.Status.InitContainerStatuses {
		if containerFailing(cs) {
			return HealthDegraded
		}
	}
	for _, cs := range p.Status.ContainerStatuses {
		if containerFailing(cs) {
			return HealthDegraded
		}
	}
	switch p.Status.Phase {
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

// containerFailing covers both windows of a crash loop: stuck waiting (CrashLoopBackOff,
// ImagePullBackOff, ...) AND sitting in Terminated with a non-zero exit between the crash and
// the next backoff restart. Without the second check a crash-looping pod read blue on every
// other status patch (kubectl shows the same window as "Error").
func containerFailing(cs corev1.ContainerStatus) bool {
	if w := cs.State.Waiting; w != nil && isFailureReason(w.Reason) {
		return true
	}
	if t := cs.State.Terminated; t != nil && t.ExitCode != 0 {
		return true
	}
	return false
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

// deploymentHealth is replica-count health plus the two states counts alone can't express: a paused
// rollout is deliberately held (Suspended), and a rollout whose progress deadline expired has been
// abandoned by the controller (Degraded) even while old replicas keep the count looking Healthy —
// otherwise it would read Progressing forever, hiding a failed deploy. Matches `kubectl rollout
// status` failing and ArgoCD.
func deploymentHealth(d *appsv1.Deployment) Health {
	if d.Spec.Paused {
		return HealthSuspended
	}
	for _, c := range d.Status.Conditions {
		if c.Type == appsv1.DeploymentProgressing && c.Status == corev1.ConditionFalse && c.Reason == "ProgressDeadlineExceeded" {
			return HealthDegraded
		}
	}
	return replicaHealth(d.Status.Replicas, d.Status.ReadyReplicas, d.Status.UpdatedReplicas, desiredReplicas(d.Spec.Replicas))
}

// replicaSetHealth is replicaHealth plus ReplicaFailure: an RS that cannot create its pods at
// all (quota exhausted, missing ServiceAccount, admission denial) declares it via this condition,
// and with no pods to carry their own red it would otherwise read Progressing forever.
func replicaSetHealth(rs *appsv1.ReplicaSet) Health {
	for _, c := range rs.Status.Conditions {
		if c.Type == appsv1.ReplicaSetReplicaFailure && c.Status == corev1.ConditionTrue {
			return HealthDegraded
		}
	}
	return replicaHealth(rs.Status.Replicas, rs.Status.ReadyReplicas, rs.Status.ReadyReplicas, desiredReplicas(rs.Spec.Replicas))
}

// replicaHealth never reports Degraded: a fresh rollout (pods pulling images, a StatefulSet
// booting pod-0 under OrderedReady) is count-indistinguishable from a total outage, so red on
// ready==0 false-alarmed every deploy-from-zero. The genuine failures are declared elsewhere and
// keep their red — failing pods themselves (CrashLoopBackOff & co), a Deployment's
// ProgressDeadlineExceeded, an RS's ReplicaFailure — matching ArgoCD, which never derives
// Degraded from workload counts.
func replicaHealth(current, ready, updated, desired int32) Health {
	if desired == 0 {
		return HealthHealthy
	}
	if ready >= desired && updated >= desired && current == desired {
		return HealthHealthy
	}
	return HealthProgressing
}

// daemonSetHealth follows the same rule as replicaHealth: counts make Progressing, never
// Degraded — only the agent pods know whether "0 ready" is a node-wide image pull or a crash.
func daemonSetHealth(d *appsv1.DaemonSet) Health {
	desired := d.Status.DesiredNumberScheduled
	if desired == 0 {
		return HealthHealthy
	}
	if d.Status.NumberReady >= desired && d.Status.UpdatedNumberScheduled >= desired {
		return HealthHealthy
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
