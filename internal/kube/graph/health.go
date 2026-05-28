package graph

import (
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
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
		return replicaHealth(o.Status.Replicas, o.Status.ReadyReplicas, o.Status.ReadyReplicas, desiredReplicas(o.Spec.Replicas))
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
	case *corev1.PersistentVolumeClaim:
		return pvcHealth(o)
	case *unstructured.Unstructured:
		return crHealth(o)
	default:
		return HealthHealthy
	}
}

// crHealth is the catch-all health rule for custom resources (kinds kd has no dedicated
// rule for). It inspects status.conditions[] for a Ready or Available condition: True →
// Healthy, False → Degraded, missing → Unknown. A CR without conditions falls back to
// Healthy (existence == health), matching ConfigMap/Service semantics.
//
// This covers most controller-written CRs (Argo, Crossplane, cert-manager, ExternalSecret,
// KEDA, …) without per-CRD config, while being honest about a CR that has no controller
// signal we can read.
func crHealth(u *unstructured.Unstructured) Health {
	conds, found, err := unstructured.NestedSlice(u.Object, "status", "conditions")
	if err != nil || !found || len(conds) == 0 {
		return HealthHealthy
	}
	// First Ready/Available decides; if neither is present, the CR has conditions but
	// none kd interprets, so report Unknown rather than glossing as Healthy.
	for _, c := range conds {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		typ, _ := m["type"].(string)
		if typ != "Ready" && typ != "Available" {
			continue
		}
		status, _ := m["status"].(string)
		switch status {
		case "True":
			return HealthHealthy
		case "False":
			return HealthDegraded
		default:
			return HealthUnknown
		}
	}
	return HealthUnknown
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

func replicaHealth(current, ready, updated, desired int32) Health {
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
