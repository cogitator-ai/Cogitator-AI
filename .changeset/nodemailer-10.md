---
'@cogitator-ai/core': patch
---

The optional `nodemailer` peer dependency of the `send_email` tool now accepts versions 6 through 10 instead of only 6. nodemailer 6 has known vulnerabilities that are fixed only in newer majors, and the old range made a fixed version a peer-dependency conflict. The tool uses only `createTransport` and `sendMail`, which are unchanged across these versions.
