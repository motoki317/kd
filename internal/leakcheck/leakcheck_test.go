package leakcheck

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"

	"k8s.io/client-go/tools/clientcmd"
)

// allowlist holds generic, non-identifying names that legitimately appear in tracked docs and
// fixtures (the documented dev context, well-known namespaces, the AWS profile placeholder).
// Compared lowercased. Everything else derived from the local kubeconfig is treated as private.
var allowlist = map[string]bool{
	"docker-desktop":   true,
	"minikube":         true,
	"kind":             true,
	"default":          true,
	"kube-system":      true,
	"kube-public":      true,
	"kube-node-lease":  true,
	"kubernetes":       true,
	"kubernetes-admin": true,
	"aws_profile":      true,
	"local":            true,
	"in-cluster":       true,
}

// minKubeconfigTokenLen drops kubeconfig-derived names too short to scan for without false
// positives ("prod", "dev"). Explicit `.leakcheck`/env tokens bypass this — the operator chose
// them deliberately.
const minKubeconfigTokenLen = 5

var (
	accountID = regexp.MustCompile(`\b\d{12}\b`)    // an AWS account number
	arnTail   = regexp.MustCompile(`/([^/:\s]+)\z`) // the resource name after the last '/' of an ARN
)

// TestTrackedFilesDoNotLeakLocalNames fails if any real local identifier reaches a tracked
// file. The forbidden set comes from the live environment, never from hardcoded names — so this
// test stays cluster-agnostic while still catching a name that only the author's machine knows.
func TestTrackedFilesDoNotLeakLocalNames(t *testing.T) {
	root, err := repoRoot()
	if err != nil {
		t.Skipf("repo root not found: %v", err)
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}

	forbidden := collectForbidden(root)
	if len(forbidden) == 0 {
		t.Skip("no local identifiers present (no kubeconfig names, no .leakcheck) — nothing to guard")
	}

	var violations []string
	for _, tok := range forbidden {
		files, err := gitGrep(root, tok)
		if err != nil {
			t.Fatalf("git grep %q: %v", tok, err)
		}
		if len(files) > 0 {
			violations = append(violations, fmt.Sprintf("%q → %s", tok, strings.Join(files, ", ")))
		}
	}
	if len(violations) > 0 {
		sort.Strings(violations)
		t.Fatalf("tracked files leak local/environment identifiers — scrub them and keep real names out of the repo "+
			"(see AGENTS.md):\n  %s", strings.Join(violations, "\n  "))
	}
}

// collectForbidden builds the denylist from the local kubeconfig (context/cluster/auth names,
// each context's namespace, ARN account IDs + resource names) plus the optional gitignored
// `.leakcheck` file and KD_LEAKCHECK_EXTRA env var.
func collectForbidden(root string) []string {
	set := map[string]bool{}

	add := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" {
			return
		}
		// An ARN context/cluster name (arn:aws:eks:…:<account>:cluster/<name>) is itself never in
		// the repo, but its account ID and cluster name must not be — forbid those parts, not the ARN.
		if strings.Contains(name, "arn:") {
			for _, id := range accountID.FindAllString(name, -1) {
				addToken(set, id, true)
			}
			if m := arnTail.FindStringSubmatch(name); m != nil {
				addToken(set, m[1], false)
			}
			return
		}
		addToken(set, name, false)
	}

	if cfg, err := clientcmd.NewDefaultClientConfigLoadingRules().Load(); err == nil {
		for n, c := range cfg.Contexts {
			add(n)
			add(c.Namespace)
		}
		for n := range cfg.Clusters {
			add(n)
		}
		for n := range cfg.AuthInfos {
			add(n)
		}
	}

	for _, tok := range readDenylist(root) {
		if !allowlist[strings.ToLower(tok)] {
			set[tok] = true // explicit: used verbatim, no length filter
		}
	}

	out := make([]string, 0, len(set))
	for tok := range set {
		out = append(out, tok)
	}
	sort.Strings(out)
	return out
}

func addToken(set map[string]bool, tok string, isAccountID bool) {
	tok = strings.TrimSpace(tok)
	if tok == "" || allowlist[strings.ToLower(tok)] {
		return
	}
	if !isAccountID && len([]rune(tok)) < minKubeconfigTokenLen {
		return
	}
	set[tok] = true
}

// readDenylist reads extra forbidden tokens an operator lists for product/service names that a
// kubeconfig can't surface. The file is gitignored; one token per line, '#' comments allowed.
func readDenylist(root string) []string {
	var toks []string
	if env := os.Getenv("KD_LEAKCHECK_EXTRA"); env != "" {
		toks = append(toks, strings.FieldsFunc(env, func(r rune) bool {
			return r == ',' || r == ' ' || r == '\t' || r == '\n'
		})...)
	}
	f, err := os.Open(filepath.Join(root, ".leakcheck"))
	if err != nil {
		return toks
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		toks = append(toks, line)
	}
	return toks
}

// gitGrep returns the tracked files containing token (case-insensitive, literal). Lock/sum files
// and the gitignored denylist are excluded — a 12-digit dependency hash is not an account-ID leak.
func gitGrep(root, token string) ([]string, error) {
	cmd := exec.Command("git", "grep", "-I", "-F", "-i", "-l", "-e", token,
		"--", ".", ":!go.sum", ":!web/package-lock.json", ":!*.bundle", ":!.leakcheck")
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
			return nil, nil // git grep exits 1 on no match
		}
		return nil, err
	}
	var files []string
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l != "" {
			files = append(files, l)
		}
	}
	return files, nil
}

func repoRoot() (string, error) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("runtime.Caller failed")
	}
	dir := filepath.Dir(file)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("go.mod not found above %s", filepath.Dir(file))
		}
		dir = parent
	}
}
