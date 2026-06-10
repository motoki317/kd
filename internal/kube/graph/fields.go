package graph

import (
	"fmt"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// This file derives the display-oriented fields of a graph Node from a Kubernetes object (restart
// counts, container names/statuses/images, host). They are pure functions over one object, kept
// apart from the health (health.go) and status-text (status.go) logic that also feed the Node.

// podRestarts totals a pod's container restarts (0 for non-pods), the at-a-glance crash signal a
// "Running" status alone hides. Init containers count too: a pod wedged in an init-crashloop has 0
// app-container restarts (they never start) but a restarting init container — the actual crash — and
// this total gates the drawer's "previous logs" button, the way to read why that init container died.
func podRestarts(obj runtime.Object) int32 {
	p, ok := obj.(*corev1.Pod)
	if !ok {
		return 0
	}
	var n int32
	for _, cs := range p.Status.InitContainerStatuses {
		n += cs.RestartCount
	}
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

// initContainerNames lists a pod's init container names (nil for non-pods, or a pod without init
// containers), in spec order. The log picker exposes them so an operator can read a failed init
// container's output — the place a pod stuck in Init records why it never started its app containers.
func initContainerNames(obj runtime.Object) []string {
	p, ok := obj.(*corev1.Pod)
	if !ok || len(p.Spec.InitContainers) == 0 {
		return nil
	}
	names := make([]string, 0, len(p.Spec.InitContainers))
	for _, c := range p.Spec.InitContainers {
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
	// Limits live on the spec containers, statuses on the status side — join by name so each
	// card can gauge its usage share against its own bound.
	limits := map[string]corev1.ResourceList{}
	for _, c := range p.Spec.InitContainers {
		limits[c.Name] = c.Resources.Limits
	}
	for _, c := range p.Spec.Containers {
		limits[c.Name] = c.Resources.Limits
	}
	out := make([]ContainerStatus, 0, len(p.Status.InitContainerStatuses)+len(p.Status.ContainerStatuses))
	for _, cs := range p.Status.InitContainerStatuses {
		out = append(out, containerStat(cs, true, limits[cs.Name]))
	}
	for _, cs := range p.Status.ContainerStatuses {
		out = append(out, containerStat(cs, false, limits[cs.Name]))
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func containerStat(cs corev1.ContainerStatus, init bool, limits corev1.ResourceList) ContainerStatus {
	// LastTerminated explains why a container that has since RESTARTED is now Running/Waiting — so it is
	// only additive when the CURRENT state isn't itself a termination. A currently-Terminated container
	// (e.g. caught mid-crashloop) already shows its exit in State; repeating the identical "last exit"
	// is gratuitous (a crashloop's previous exit is the same). Suppress it there.
	last := ""
	if cs.State.Terminated == nil {
		last = lastTerminatedString(cs.LastTerminationState)
	}
	st := ContainerStatus{Name: cs.Name, Ready: cs.Ready, Restarts: cs.RestartCount, State: containerStateString(cs.State), Init: init, Image: cs.Image, LastTerminated: last}
	if cpu, ok := limits[corev1.ResourceCPU]; ok {
		st.CPULimitMilli = cpu.MilliValue()
	}
	if mem, ok := limits[corev1.ResourceMemory]; ok {
		st.MemLimitBytes = mem.Value()
	}
	return st
}

// terminatedDetail formats how a container exited: "OOMKilled (exit 137)", a bare reason on a clean
// exit ("Completed"), "exit 137" when the runtime gave no reason, or "" when there is nothing to say
// (no reason and a zero exit). The exit code is appended only when non-zero — "Completed" reads cleaner
// than "Completed (exit 0)". Shared by the current-state and last-state renderers so a container's
// termination reads the SAME way whether it is its live state or the previous one it restarted from.
func terminatedDetail(t *corev1.ContainerStateTerminated) string {
	if t == nil || (t.Reason == "" && t.ExitCode == 0) {
		return ""
	}
	switch {
	case t.Reason != "" && t.ExitCode != 0:
		return fmt.Sprintf("%s (exit %d)", t.Reason, t.ExitCode)
	case t.Reason != "":
		return t.Reason
	default:
		return fmt.Sprintf("exit %d", t.ExitCode)
	}
}

// lastTerminatedString renders the PREVIOUS termination of a restarted container (lastState), empty
// when the container never terminated before — answers "why did this now-Running container restart".
func lastTerminatedString(s corev1.ContainerState) string {
	return terminatedDetail(s.Terminated)
}

// containerStateString renders a container's current state as "Running", "Waiting: <reason>", or
// "Terminated: <reason> (exit <code>)" — the reason + exit code are the actionable part
// (CrashLoopBackOff, OOMKilled, a non-zero exit). A clean "Terminated: Completed" omits the exit code.
// A waiting state's MESSAGE is the root cause an operator otherwise digs out of Events ("image not
// found", "configmap 'x' not found") — append it, except for CrashLoopBackOff, whose message is
// mechanical backoff state (delay + pod UID) while the real cause is the last exit, shown separately.
func containerStateString(s corev1.ContainerState) string {
	switch {
	case s.Running != nil:
		return "Running"
	case s.Waiting != nil:
		if s.Waiting.Reason != "" {
			if s.Waiting.Message != "" && s.Waiting.Reason != "CrashLoopBackOff" {
				return "Waiting: " + s.Waiting.Reason + " — " + truncateRunes(s.Waiting.Message, 200)
			}
			return "Waiting: " + s.Waiting.Reason
		}
		return "Waiting"
	case s.Terminated != nil:
		if d := terminatedDetail(s.Terminated); d != "" {
			return "Terminated: " + d
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

// nodeCapacity summarizes a Node's allocatable size as "<cpu> vCPU · <mem> · <pods> pods" ("" for
// non-nodes), the "how big is this node / how much can it hold" context otherwise buried in the
// manifest. Uses allocatable (capacity minus system-reserved) — what workloads can actually use.
func nodeCapacity(obj runtime.Object) string {
	n, ok := obj.(*corev1.Node)
	if !ok {
		return ""
	}
	alloc := n.Status.Allocatable
	cpu, mem, pods := alloc.Cpu(), alloc.Memory(), alloc.Pods()
	if cpu.IsZero() && mem.IsZero() {
		return "" // capacity not reported yet
	}
	parts := []string{cpu.String() + " vCPU", humanizeBytes(mem.Value())}
	if !pods.IsZero() {
		parts = append(parts, pods.String()+" pods")
	}
	return strings.Join(parts, " · ")
}

// nodeTaints summarizes a Node's scheduling taints as "key[=value]:Effect" entries joined by ", "
// ("" for non-nodes or an untainted node) — the answer to "why won't a pod land here without a
// matching toleration", otherwise buried in the manifest. A control-plane / unreachable / fargate /
// dedicated taint is exactly what an operator hunts for when a pod stays Pending.
func nodeTaints(obj runtime.Object) string {
	n, ok := obj.(*corev1.Node)
	if !ok || len(n.Spec.Taints) == 0 {
		return ""
	}
	parts := make([]string, 0, len(n.Spec.Taints))
	for _, t := range n.Spec.Taints {
		s := t.Key
		if t.Value != "" {
			s += "=" + t.Value
		}
		parts = append(parts, s+":"+string(t.Effect))
	}
	return strings.Join(parts, ", ")
}

// nodeAllocatable returns a Node's schedulable capacity as structured canonical-unit quantities (nil
// for non-nodes), the machine-readable counterpart of nodeCapacity that the capacity view does math
// on. Mirrors nodeCapacity's zero-guard: a node that hasn't reported cpu+mem yet yields nil.
func nodeAllocatable(obj runtime.Object) *Resources {
	n, ok := obj.(*corev1.Node)
	if !ok {
		return nil
	}
	alloc := n.Status.Allocatable
	cpu, mem, pods := alloc.Cpu(), alloc.Memory(), alloc.Pods()
	if cpu.IsZero() && mem.IsZero() {
		return nil // capacity not reported yet
	}
	cpuMilli, memBytes, podCount := cpu.MilliValue(), mem.Value(), pods.Value()
	return &Resources{CPUMilli: &cpuMilli, MemBytes: &memBytes, Pods: &podCount}
}

// nodeTotalCapacity returns a Node's TOTAL physical capacity (status.capacity) as structured
// quantities — the counterpart of nodeAllocatable but BEFORE system/kube-reserved is subtracted.
// The capacity view's Use bar gauges actual usage against this (a node can use into the reserved
// region — kubelet, the runtime), while requests still gauge against allocatable (the schedulable
// pool). Mirrors the zero-guard: a node that hasn't reported cpu+mem yet yields nil.
func nodeTotalCapacity(obj runtime.Object) *Resources {
	n, ok := obj.(*corev1.Node)
	if !ok {
		return nil
	}
	total := n.Status.Capacity
	cpu, mem, pods := total.Cpu(), total.Memory(), total.Pods()
	if cpu.IsZero() && mem.IsZero() {
		return nil
	}
	cpuMilli, memBytes, podCount := cpu.MilliValue(), mem.Value(), pods.Value()
	return &Resources{CPUMilli: &cpuMilli, MemBytes: &memBytes, Pods: &podCount}
}

// podRequests sums a Pod's per-container resource requests into canonical units (nil for non-pods).
// CPU and memory are independent: a field stays nil unless at least one container sets it, so "no CPU
// request" reads distinctly from "0" in the capacity view.
func podRequests(obj runtime.Object) *Resources {
	return podResources(obj, func(c corev1.Container) corev1.ResourceList { return c.Resources.Requests })
}

// podLimits sums a Pod's per-container resource limits, with the same nil-vs-set semantics as
// podRequests.
func podLimits(obj runtime.Object) *Resources {
	return podResources(obj, func(c corev1.Container) corev1.ResourceList { return c.Resources.Limits })
}

func podResources(obj runtime.Object, which func(corev1.Container) corev1.ResourceList) *Resources {
	p, ok := obj.(*corev1.Pod)
	if !ok {
		return nil
	}
	// Init containers are excluded: the effective request is max(initmax, sum(app)), but for a
	// "feel the size" capacity view summing the app containers is the right first cut.
	cpuMilli, memBytes := sumContainerResource(p.Spec.Containers, which)
	if cpuMilli == nil && memBytes == nil {
		return nil
	}
	return &Resources{CPUMilli: cpuMilli, MemBytes: memBytes}
}

// sumContainerResource totals one resource kind (cpu, mem) across containers, returning a nil pointer
// for a resource no container sets so the caller can keep "unset" distinct from "0".
func sumContainerResource(containers []corev1.Container, which func(corev1.Container) corev1.ResourceList) (cpuMilli, memBytes *int64) {
	for _, c := range containers {
		list := which(c)
		if q, ok := list[corev1.ResourceCPU]; ok {
			v := q.MilliValue()
			cpuMilli = addInt64(cpuMilli, v)
		}
		if q, ok := list[corev1.ResourceMemory]; ok {
			v := q.Value()
			memBytes = addInt64(memBytes, v)
		}
	}
	return cpuMilli, memBytes
}

func addInt64(acc *int64, v int64) *int64 {
	if acc == nil {
		return &v
	}
	sum := *acc + v
	return &sum
}

// humanizeBytes renders a byte count as a binary-unit string (Ki/Mi/Gi/Ti), matching how Kubernetes
// reports memory, so a Node's RAM reads as "16Gi" rather than a raw byte count.
func humanizeBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%dB", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.0f%ci", float64(b)/float64(div), "KMGTPE"[exp])
}
