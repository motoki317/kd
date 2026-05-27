package graph

import (
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// This file derives the display-oriented fields of a graph Node from a Kubernetes object (restart
// counts, container names/statuses/images, host). They are pure functions over one object, kept
// apart from the health (health.go) and status-text (status.go) logic that also feed the Node.

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

// podHost returns the node a pod is scheduled on ("" for non-pods or unscheduled pods), placement
// context the operator otherwise has to dig out of the manifest.
func podHost(obj runtime.Object) string {
	if p, ok := obj.(*corev1.Pod); ok {
		return p.Spec.NodeName
	}
	return ""
}
