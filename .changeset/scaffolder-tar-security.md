---
'create-cogitator-app': patch
---

Require `tar` 7.5.22 or later. Earlier versions are open to hardlink and symlink path traversal and to several denial of service bugs, and the scaffolder extracts template archives downloaded from GitHub.
