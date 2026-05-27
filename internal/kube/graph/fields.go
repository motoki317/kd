package graph

import (
	"fmt"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
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

// servicePorts formats a Service's port mappings as "[name ]port[→target][:nodePort]/proto" (nil for
// non-services), the "what does this route to, on which port" detail the network view needs without
// opening the manifest. The target port is shown only when it differs from the service port, and the
// node port only when set (NodePort/LoadBalancer).
func servicePorts(obj runtime.Object) []string {
	svc, ok := obj.(*corev1.Service)
	if !ok {
		return nil
	}
	if len(svc.Spec.Ports) == 0 {
		return nil
	}
	out := make([]string, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		s := fmt.Sprintf("%d", p.Port)
		if tp := p.TargetPort.String(); tp != "" && tp != "0" && tp != s {
			s += "→" + tp
		}
		if p.NodePort != 0 {
			s += fmt.Sprintf(":%d", p.NodePort)
		}
		proto := p.Protocol
		if proto == "" {
			proto = corev1.ProtocolTCP
		}
		s += "/" + string(proto)
		if p.Name != "" {
			s = p.Name + " " + s
		}
		out = append(out, s)
	}
	return out
}

// ingressRoutes formats an Ingress's routing table as "host/path → service:port" rows (nil for
// non-ingresses), so the network view's entry point says where external traffic actually goes without
// opening the manifest. A hostless rule shows "*", an empty path "/", and a default backend leads as
// "default → …". The Ingress→Service edges already show the targets; this adds the host/path mapping.
func ingressRoutes(obj runtime.Object) []string {
	ing, ok := obj.(*networkingv1.Ingress)
	if !ok {
		return nil
	}
	var routes []string
	if db := ing.Spec.DefaultBackend; db != nil && db.Service != nil {
		routes = append(routes, "default → "+ingressBackend(db.Service))
	}
	for _, r := range ing.Spec.Rules {
		if r.HTTP == nil {
			continue
		}
		host := r.Host
		if host == "" {
			host = "*"
		}
		for _, p := range r.HTTP.Paths {
			if p.Backend.Service == nil {
				continue // resource backends (non-Service) have no node to point at
			}
			path := p.Path
			if path == "" {
				path = "/"
			}
			routes = append(routes, host+path+" → "+ingressBackend(p.Backend.Service))
		}
	}
	return routes
}

// ingressBackend renders an Ingress backend as "service:port", using the named port when set.
func ingressBackend(s *networkingv1.IngressServiceBackend) string {
	switch {
	case s.Port.Name != "":
		return s.Name + ":" + s.Port.Name
	case s.Port.Number != 0:
		return fmt.Sprintf("%s:%d", s.Name, s.Port.Number)
	default:
		return s.Name
	}
}

// roleRules formats a Role/ClusterRole's policy rules as "resources: verbs" rows (nil otherwise), so
// the RBAC view answers "what does this grant?" at a glance instead of in the manifest. Resources are
// shown kubectl-style ("deployments.apps", core group bare), resourceNames in [brackets], and a
// non-resource-URL rule (ClusterRole) as "url: verbs".
func roleRules(obj runtime.Object) []string {
	var rules []rbacv1.PolicyRule
	switch o := obj.(type) {
	case *rbacv1.Role:
		rules = o.Rules
	case *rbacv1.ClusterRole:
		rules = o.Rules
	default:
		return nil
	}
	out := make([]string, 0, len(rules))
	for _, r := range rules {
		verbs := strings.Join(r.Verbs, ", ")
		if len(r.NonResourceURLs) > 0 {
			out = append(out, strings.Join(r.NonResourceURLs, ", ")+": "+verbs)
			continue
		}
		var res []string
		for _, group := range r.APIGroups {
			for _, name := range r.Resources {
				if group == "" {
					res = append(res, name)
				} else {
					res = append(res, name+"."+group)
				}
			}
		}
		line := strings.Join(res, ", ")
		if len(r.ResourceNames) > 0 {
			line += " [" + strings.Join(r.ResourceNames, ", ") + "]"
		}
		out = append(out, line+": "+verbs)
	}
	return out
}

// bindingRoleRef renders a RoleBinding/ClusterRoleBinding's target role as "Kind/name" ("" otherwise).
// The binding→role edge already shows an in-namespace Role, but a roleRef to a cluster-scoped
// ClusterRole has no node in a namespace graph, so this is the only place that target is visible.
func bindingRoleRef(obj runtime.Object) string {
	switch o := obj.(type) {
	case *rbacv1.RoleBinding:
		return o.RoleRef.Kind + "/" + o.RoleRef.Name
	case *rbacv1.ClusterRoleBinding:
		return o.RoleRef.Kind + "/" + o.RoleRef.Name
	default:
		return ""
	}
}

// bindingSubjects renders who a RoleBinding/ClusterRoleBinding grants to as "Kind: [namespace/]name"
// rows (nil otherwise). User and Group subjects aren't Kubernetes objects, so they have no node and
// are invisible in the topology — this surfaces them, the core "who got access" audit answer.
func bindingSubjects(obj runtime.Object) []string {
	var subjects []rbacv1.Subject
	switch o := obj.(type) {
	case *rbacv1.RoleBinding:
		subjects = o.Subjects
	case *rbacv1.ClusterRoleBinding:
		subjects = o.Subjects
	default:
		return nil
	}
	if len(subjects) == 0 {
		return nil
	}
	out := make([]string, 0, len(subjects))
	for _, s := range subjects {
		name := s.Name
		if s.Kind == "ServiceAccount" && s.Namespace != "" {
			name = s.Namespace + "/" + s.Name
		}
		out = append(out, s.Kind+": "+name)
	}
	return out
}

// serviceClusterIP returns a Service's reachable address for the drawer: its cluster IP, "headless"
// for a headless (ClusterIP: None) service, or the aliased host for an ExternalName service. "" for
// non-services or a not-yet-assigned IP, so the drawer omits it.
func serviceClusterIP(obj runtime.Object) string {
	svc, ok := obj.(*corev1.Service)
	if !ok {
		return ""
	}
	switch {
	case svc.Spec.Type == corev1.ServiceTypeExternalName:
		return svc.Spec.ExternalName
	case svc.Spec.ClusterIP == corev1.ClusterIPNone:
		return "headless"
	default:
		return svc.Spec.ClusterIP
	}
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
