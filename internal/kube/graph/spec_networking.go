package graph

// Service/Ingress-facing reachability essence — addresses, ports, selectors, ingress classes: the
// "how do I reach this" facts for the network view. The routing tables (Ingress/HTTPRoute/
// IngressRoute "match → backend" rows) live in spec_routing.go.

import (
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

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

// serviceSelector renders a Service's pod selector as "k=v, k=v" (sorted), the answer to a Service's
// most common failure — "no endpoints" means this selector matches no ready pod, so showing it lets an
// operator spot a typo'd label or a renamed workload without opening the manifest. "" for a non-service
// or a selectorless Service (ExternalName, or one with manually-managed endpoints), so the drawer omits
// it — those have no selector to debug. Mirrors the selector kd already surfaces for NetworkPolicies.
func serviceSelector(obj runtime.Object) string {
	svc, ok := obj.(*corev1.Service)
	if !ok {
		return ""
	}
	return labelMapString(svc.Spec.Selector)
}

// externalAddress returns a Service's or Ingress's external reachability — the "how do I reach this
// from outside the cluster" answer the cluster IP can't give. Both carry a status.loadBalancer.ingress
// list of the same shape, so they share one reader: a LoadBalancer Service's assigned ingress IP (or
// hostname, or "pending" while it provisions) plus admin-set spec.externalIPs; an Ingress's controller-
// reported address (the ALB/Traefik hostname an operator actually curls — the entry point the routing
// table sends traffic to). An IP is preferred over a hostname as the more specific address. "" when
// nothing external applies (a plain ClusterIP service, an Ingress no controller has claimed), so the
// drawer omits it.
func externalAddress(obj runtime.Object) string {
	switch o := obj.(type) {
	case *corev1.Service:
		var addrs []string
		for _, ing := range o.Status.LoadBalancer.Ingress {
			addrs = appendLBAddr(addrs, ing.IP, ing.Hostname)
		}
		addrs = append(addrs, o.Spec.ExternalIPs...)
		if len(addrs) == 0 {
			if o.Spec.Type == corev1.ServiceTypeLoadBalancer {
				return "pending" // requested an external IP; the provider hasn't assigned one yet
			}
			return ""
		}
		return strings.Join(addrs, ", ")
	case *networkingv1.Ingress:
		// No "pending" sentinel: an Ingress with no address simply hasn't been claimed by a controller
		// yet (or there is none) — the routing table still shows where it WOULD route, so an empty
		// address is silent rather than alarming. (The two status types are distinct structs with the
		// same IP/Hostname fields, hence the per-kind loops over a shared appender.)
		var addrs []string
		for _, ing := range o.Status.LoadBalancer.Ingress {
			addrs = appendLBAddr(addrs, ing.IP, ing.Hostname)
		}
		return strings.Join(addrs, ", ")
	}
	return ""
}

// appendLBAddr adds a load-balancer entry's address, preferring its IP over its hostname (the more
// specific reachability). A no-op when both are empty.
func appendLBAddr(addrs []string, ip, hostname string) []string {
	if ip != "" {
		return append(addrs, ip)
	}
	if hostname != "" {
		return append(addrs, hostname)
	}
	return addrs
}

// ingressClassSummary renders an IngressClass's essence — the controller that handles Ingresses of
// this class, and whether it's the cluster default (the `is-default-class` annotation, i.e. the
// controller that picks up an Ingress with no className). This answers "which controller serves my
// Ingress" — otherwise the IngressClass card showed only its age. Empty for any other kind. An
// IngressClass arrives unstructured (networking types beyond the few kd converts stay unstructured).
func ingressClassSummary(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "IngressClass")
	if u == nil {
		return ""
	}
	controller, _, _ := unstructured.NestedString(u.Object, "spec", "controller")
	if controller == "" {
		return ""
	}
	parts := []string{controller}
	if u.GetAnnotations()["ingressclass.kubernetes.io/is-default-class"] == "true" {
		parts = append(parts, "default")
	}
	return strings.Join(parts, " · ")
}
