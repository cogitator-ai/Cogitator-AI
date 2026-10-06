---
'@cogitator-ai/workflows': patch
---

An agent turn that pauses on two identical calls of one tool now opens an approval request for each call. The requests were identified by their content only, so both calls shared one request and a single approval let both run. A `toolNode` names its call after the node and its visit, so a run that resumes after a restart still finds the answer given meanwhile. Node contexts gain `visit`, how many times the node has run in this workflow run.
