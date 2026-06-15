package graph

// Guardrail-policy essence — NetworkPolicy allow/deny summaries, admission webhook fail modes, and
// PodDisruptionBudget intent/headroom: the rules that constrain other resources.

import (
	"fmt"
	"strings"

	networkingv1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// networkPolicySummary distills a NetworkPolicy into the lines an operator debugging "why can't A reach
// B" needs without opening the YAML: which pods it applies to (podSelector), and for each GOVERNED
// direction the actual peers each rule allows — "Ingress 50051/TCP ← ui-a, team-b/api-b,
// …" — because "who can reach these pods" is the whole question a NetworkPolicy answers, and a bare rule
// COUNT ("1 rule") left it unanswered (and hid that an empty rule is actually allow-from-anywhere). A
// governed direction with no rules denies all (a lockdown); a direction not in policyTypes isn't
// governed, so it's omitted rather than read as an explicit "allow all". nil for non-NetworkPolicies.
func networkPolicySummary(obj runtime.Object) []string {
	np, ok := obj.(*networkingv1.NetworkPolicy)
	if !ok {
		return nil
	}
	governs := func(t networkingv1.PolicyType) bool {
		for _, p := range np.Spec.PolicyTypes {
			if p == t {
				return true
			}
		}
		return false
	}
	out := []string{"targets: " + selectorSummary(&np.Spec.PodSelector)}
	if governs(networkingv1.PolicyTypeIngress) {
		if len(np.Spec.Ingress) == 0 {
			out = append(out, "Ingress: deny all")
		} else {
			for _, r := range np.Spec.Ingress {
				out = append(out, npRule("Ingress", "←", npPorts(r.Ports), npPeers(r.From)))
			}
		}
	}
	if governs(networkingv1.PolicyTypeEgress) {
		if len(np.Spec.Egress) == 0 {
			out = append(out, "Egress: deny all")
		} else {
			for _, r := range np.Spec.Egress {
				out = append(out, npRule("Egress", "→", npPorts(r.Ports), npPeers(r.To)))
			}
		}
	}
	return out
}

// npRule formats one NetworkPolicy rule as "<dir>[ ports] <arrow> <peers>". Empty peers (an empty
// from/to selects every source) reads "anywhere"; empty ports (all ports) is omitted.
func npRule(dir, arrow, ports, peers string) string {
	s := dir
	if ports != "" {
		s += " " + ports
	}
	if peers == "" {
		peers = "anywhere"
	}
	return s + " " + arrow + " " + peers
}

// npPeers joins a rule's peers with ", " ("" when the list is empty — the caller renders "anywhere").
func npPeers(peers []networkingv1.NetworkPolicyPeer) string {
	out := make([]string, 0, len(peers))
	for _, p := range peers {
		if s := npPeer(p); s != "" {
			out = append(out, s)
		}
	}
	return strings.Join(out, ", ")
}

// npPeer renders one NetworkPolicyPeer: an ipBlock CIDR, a cross-namespace "<namespace>/<pods>" selector,
// a "<namespace>/all pods" when only a namespace is named, or just the pod selector for a same-namespace
// peer. The namespace shows by name when the idiomatic kubernetes.io/metadata.name label is used.
func npPeer(p networkingv1.NetworkPolicyPeer) string {
	if p.IPBlock != nil {
		s := p.IPBlock.CIDR
		if len(p.IPBlock.Except) > 0 {
			s += " except " + strings.Join(p.IPBlock.Except, ", ")
		}
		return s
	}
	if p.NamespaceSelector != nil {
		ns := npNamespace(p.NamespaceSelector)
		if p.PodSelector != nil {
			return ns + "/" + selectorSummary(p.PodSelector)
		}
		return ns + "/all pods"
	}
	if p.PodSelector != nil {
		return selectorSummary(p.PodSelector)
	}
	return ""
}

// npNamespace names a peer's namespaceSelector: the namespace's own name when it uses the idiomatic
// immutable kubernetes.io/metadata.name label ("namespace named X"), "all ns" when empty (every
// namespace), else the raw label match.
func npNamespace(sel *metav1.LabelSelector) string {
	if sel != nil && len(sel.MatchExpressions) == 0 && len(sel.MatchLabels) == 1 {
		if name, ok := sel.MatchLabels["kubernetes.io/metadata.name"]; ok {
			return name
		}
	}
	if sel == nil || (len(sel.MatchLabels) == 0 && len(sel.MatchExpressions) == 0) {
		return "all ns"
	}
	return selectorSummary(sel)
}

// npPorts renders a rule's ports as "port/proto[, …]" ("" when none → all ports). A port may be numeric
// or a named port; the protocol defaults to TCP as Kubernetes does. A protocol-only entry (no port)
// shows just the protocol.
func npPorts(ports []networkingv1.NetworkPolicyPort) string {
	out := make([]string, 0, len(ports))
	for _, p := range ports {
		proto := "TCP"
		if p.Protocol != nil {
			proto = string(*p.Protocol)
		}
		if p.Port == nil {
			out = append(out, proto)
		} else {
			out = append(out, p.Port.String()+"/"+proto)
		}
	}
	return strings.Join(out, ", ")
}

// webhookConfigSummary renders an admission webhook configuration's essence — how many webhooks it
// registers and whether any is fail-closed ("3 webhooks · Fail"). failurePolicy is the operationally
// critical fact: a Fail webhook whose backend is down BLOCKS every matching API operation (the classic
// "I can't create anything" cluster outage), while Ignore degrades gracefully. v1 defaults an unset
// policy to Fail, so absence counts as fail-closed; a config with any fail-closed webhook reads "Fail".
// Empty for any other kind. ValidatingWebhookConfiguration/MutatingWebhookConfiguration arrive
// unstructured (admissionregistration types aren't in kd's typed factories).
func webhookConfigSummary(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "ValidatingWebhookConfiguration", "MutatingWebhookConfiguration")
	if u == nil {
		return ""
	}
	webhooks, _, _ := unstructured.NestedSlice(u.Object, "webhooks")
	if len(webhooks) == 0 {
		return ""
	}
	failClosed := false
	for _, wi := range webhooks {
		w, ok := wi.(map[string]any)
		if !ok {
			continue
		}
		if fp, _ := w["failurePolicy"].(string); fp != "Ignore" { // unset defaults to Fail in v1
			failClosed = true
		}
	}
	policy := "Ignore"
	if failClosed {
		policy = "Fail"
	}
	unit := "webhooks"
	if len(webhooks) == 1 {
		unit = "webhook"
	}
	return fmt.Sprintf("%d %s · %s", len(webhooks), unit, policy)
}

// pdbPolicy renders a PodDisruptionBudget's configured intent — "min N" (minAvailable) or "max N"
// (maxUnavailable), where N is a count or a percentage — the policy the status's "healthy" count alone
// doesn't reveal. Empty for non-PDBs or a PDB with neither set (invalid, but don't panic).
func pdbPolicy(obj runtime.Object) string {
	p, ok := obj.(*policyv1.PodDisruptionBudget)
	if !ok {
		return ""
	}
	switch {
	case p.Spec.MinAvailable != nil:
		return "min " + p.Spec.MinAvailable.String()
	case p.Spec.MaxUnavailable != nil:
		return "max " + p.Spec.MaxUnavailable.String()
	}
	return ""
}

// pdbDisruptions renders how many voluntary evictions a PDB allows right now (status.disruptionsAllowed)
// as a string so "0" — the operationally critical "a node drain will block here" state — is surfaced,
// not hidden by an omitempty zero. Empty only for non-PDBs.
func pdbDisruptions(obj runtime.Object) string {
	if p, ok := obj.(*policyv1.PodDisruptionBudget); ok {
		return fmt.Sprintf("%d", p.Status.DisruptionsAllowed)
	}
	return ""
}
