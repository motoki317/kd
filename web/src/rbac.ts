// ruleHasWildcardVerb detects a Role/ClusterRole rule that grants the `*` verb — it can perform ANY
// action (create, delete, escalate, impersonate, …) on its resources, the single clearest RBAC
// over-privilege signal an auditor scans for. The input is roleRules()'s "<resources>: <verbs>"
// string (verbs comma-joined after the LAST ": "); we test ONLY the verbs segment, so a wildcard in
// a non-resource URL path ("/api/*: get") is never misread as a wildcard verb.
export function ruleHasWildcardVerb(rule: string): boolean {
  const i = rule.lastIndexOf(': ')
  if (i < 0) return false
  return rule
    .slice(i + 2)
    .split(', ')
    .includes('*')
}
