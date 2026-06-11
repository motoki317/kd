package graph

// cert-manager essence — what a Certificate covers, who signs it, when it expires, and what backs an
// Issuer/ClusterIssuer (where prod-vs-staging ACME must be unmissable).

import (
	"net/url"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// certNames extracts the names a cert-manager Certificate secures — spec.commonName plus
// spec.dnsNames, deduplicated, in declaration order. "What does this cert cover?" is the first
// question at a TLS failure, and it lived only in the manifest.
func certNames(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "Certificate")
	if u == nil {
		return ""
	}
	var names []string
	seen := map[string]bool{}
	add := func(n string) {
		if n != "" && !seen[n] {
			seen[n] = true
			names = append(names, n)
		}
	}
	if cn, _, _ := unstructured.NestedString(u.Object, "spec", "commonName"); cn != "" {
		add(cn)
	}
	if dns, found, _ := unstructured.NestedStringSlice(u.Object, "spec", "dnsNames"); found {
		for _, n := range dns {
			add(n)
		}
	}
	return strings.Join(names, ", ")
}

// certIssuer extracts a Certificate's issuerRef name — naming it in the drawer catches the classic
// staging-vs-production issuer mix-up without opening the manifest.
func certIssuer(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "Certificate")
	if u == nil {
		return ""
	}
	name, _, _ := unstructured.NestedString(u.Object, "spec", "issuerRef", "name")
	return name
}

// certExpiry extracts a Certificate's status.notAfter (RFC3339) — empty until cert-manager issues
// the first certificate. The client renders it relative ("in 84d"); an already-expired cert is
// flagged by the Ready condition's health, not by this chip.
func certExpiry(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "Certificate")
	if u == nil {
		return ""
	}
	notAfter, _, _ := unstructured.NestedString(u.Object, "status", "notAfter")
	return notAfter
}

// issuerConfig summarizes a cert-manager Issuer or ClusterIssuer's backing CA — the answer to "what
// actually signs my certs?", which lived only in the manifest. The spec carries exactly one of acme/
// ca/vault/selfSigned/venafi; for ACME the server URL is the load-bearing fact (Let's Encrypt's
// staging endpoint issues UNTRUSTED certs — the #1 cert-manager mistake — so prod vs staging must be
// obvious). "" for other kinds.
func issuerConfig(obj runtime.Object) string {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok || (u.GetKind() != "Issuer" && u.GetKind() != "ClusterIssuer") {
		return ""
	}
	spec, found, _ := unstructured.NestedMap(u.Object, "spec")
	if !found {
		return ""
	}
	if acme, ok := spec["acme"].(map[string]any); ok {
		server, _ := acme["server"].(string)
		return "ACME · " + acmeServerName(server)
	}
	for key, label := range map[string]string{"ca": "CA", "vault": "Vault", "selfSigned": "SelfSigned", "venafi": "Venafi"} {
		if _, ok := spec[key]; ok {
			return label
		}
	}
	return ""
}

// acmeServerName turns an ACME directory URL into the operator-meaningful label, making the
// untrusted-staging-vs-trusted-prod Let's Encrypt distinction unmissable; an unknown ACME server
// falls back to its host so a private ACME (step-ca, ZeroSSL) still reads.
func acmeServerName(server string) string {
	switch {
	case server == "":
		return "unknown server"
	case strings.Contains(server, "acme-staging") && strings.Contains(server, "letsencrypt.org"):
		return "Let's Encrypt (staging — untrusted)"
	case strings.Contains(server, "letsencrypt.org"):
		return "Let's Encrypt"
	default:
		if u, err := url.Parse(server); err == nil && u.Host != "" {
			return u.Host
		}
		return server
	}
}
