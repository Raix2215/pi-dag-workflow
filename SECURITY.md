# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's security advisories:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the issue, affected versions, and a minimal reproduction if you can.

If private reporting is not enabled on the repository, open a regular issue asking the maintainers to enable it; keep the details of the vulnerability out of that public issue.

Please do not disclose a vulnerability publicly until a fix has been released.

## Scope

pi-dag-workflow is an extension for Pi. Plan mode and tool selection are execution guards, not an operating-system sandbox: extensions and writable child processes run with the user's own OS permissions. Reports about unexpected writes, command execution, credential exposure, or child-process isolation are in scope.

## Notes

- No security contact email is provided here. Use GitHub private advisories.
- The default checks and CI do not require model credentials and do not call paid models, so they should not expose secrets.
