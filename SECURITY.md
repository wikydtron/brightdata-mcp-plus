# Security

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security tab) rather than
a public issue.

In scope: SSRF bypasses of the direct-fetch guard, prompt-injection paths around the untrusted-content wrapper or the
content gate, credential leaks in logs or errors, and cross-session data leaks in HTTP mode.

The design is summarised in the README's [Security model](README.md#security-model).
