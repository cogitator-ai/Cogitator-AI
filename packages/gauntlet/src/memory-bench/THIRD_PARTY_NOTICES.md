# Third-party notices

The memory benchmark stand reproduces prompts and evaluators of the benchmarks it runs, so its scores follow each benchmark's own method. The datasets themselves are downloaded at run time and are not part of this repository.

## LongMemEval

The answer check prompts in `scoring.ts` are taken from `src/evaluation/evaluate_qa.py` of https://github.com/xiaowu0162/LongMemEval.

```
MIT License

Copyright (c) 2024 Di Wu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## BEAM

The rubric judge prompt (`unified_llm_judge_base_prompt`) in `scoring.ts` is taken from `src/prompts.py` of https://github.com/mohammadtavakoli78/BEAM, with typographic quotes written as straight ones.

```
MIT License

Copyright (c) 2025 Mohammad Tavakoli

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## LongMemEval-V2

The evaluators in `scoring.ts` (`extract_boxed_answer`, `norm_phrase_set_match`, `norm_phrase_set_match_ordered`, `mc_choice_match`, `mc_choice_set_match` and the prompts of `llm_abstention_checker` and `llm_gotchas_checker`) are ported to TypeScript from `evaluation/qa_eval_metrics.py`, and the domain answering rules in `datasets/longmemeval-v2.ts` are taken from `evaluation/harness.py`, of https://github.com/xiaowu0162/LongMemEval-V2, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: translated from Python to TypeScript, the LLM checkers run through this stand's judge instead of an OpenAI client.
