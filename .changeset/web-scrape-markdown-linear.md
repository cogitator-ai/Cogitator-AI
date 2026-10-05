---
'@cogitator-ai/core': patch
---

`web_scrape` renders Markdown in linear time. Each link rebuilt the whole Markdown string written so far to wrap its text, so a page of many links took time quadratic in its length: 40,000 unclosed headings with links took about 750 ms instead of 45. The Markdown is now kept in parts and a link rewrites only its own.
