package graph

import (
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// This file surfaces the declarative spec of the resources that anchor the relationship views — a
// Service's address/ports, an Ingress's routes, a Role's rules, a binding's grantees — as
// display-ready strings on the graph Node. They answer "what does this resource declare" for the
// network and RBAC views, the counterpart to fields.go's "what is this pod/node doing at runtime".

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

// serviceExternalAddress returns a Service's external reachability — the "how do I reach this from
// outside the cluster" answer the cluster IP can't give: a LoadBalancer's assigned ingress IP (or
// hostname, or "pending" while it provisions) and any admin-set spec.externalIPs. An IP is preferred
// over a hostname as the more specific address. "" for a plain ClusterIP service (nothing external)
// or non-services, so the drawer omits it.
func serviceExternalAddress(obj runtime.Object) string {
	svc, ok := obj.(*corev1.Service)
	if !ok {
		return ""
	}
	var addrs []string
	for _, ing := range svc.Status.LoadBalancer.Ingress {
		if ing.IP != "" {
			addrs = append(addrs, ing.IP)
		} else if ing.Hostname != "" {
			addrs = append(addrs, ing.Hostname)
		}
	}
	addrs = append(addrs, svc.Spec.ExternalIPs...)
	if len(addrs) == 0 {
		if svc.Spec.Type == corev1.ServiceTypeLoadBalancer {
			return "pending" // requested an external IP; the provider hasn't assigned one yet
		}
		return ""
	}
	return strings.Join(addrs, ", ")
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
