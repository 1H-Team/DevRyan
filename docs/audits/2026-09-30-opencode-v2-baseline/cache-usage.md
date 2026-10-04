| Case | Run | Steps | Input tokens | Cache read | Output | Cache-read ratio | Continuity breaks (warm-gap, lost prefix) | Routes |
|---|---|---|---|---|---|---|---|---|
| `l0-direct` | p0a | 5 | 115621 | 90752 | 216 | 0.785 | 0 (0, 0) | openai/gpt-6-astra: 5 obs, ratio 0.785 |
| `l1-fix` | p0a | 19 | 421161 | 368000 | 2199 | 0.874 | 0 (0, 0) | openai/gpt-6-astra: 8 obs, ratio 0.858; openai/gpt-6.1-sol: 11 obs, ratio 0.888 |
| `l1-fix` | p0d | 17 | 482892 | 378240 | 2294 | 0.783 | 2 (2, 33973) | openai/gpt-6-astra: 8 obs, ratio 0.857; openai/gpt-6.1-sol: 9 obs, ratio 0.732 |
| `l10-parent-resume` | p0b | 13 | 294343 | 239104 | 4531 | 0.812 | 0 (0, 0) | openai/gpt-6-astra: 5 obs, ratio 0.772; opencode-go/deepseek-v4.1-flash: 8 obs, ratio 0.838 |
| `l11-review-council` | p0b | 7 | 116216 | 90496 | 524 | 0.779 | 0 (0, 0) | openai/gpt-6-astra: 5 obs, ratio 0.779 |
| `l12-stop` | p0a | 2 | 20971 | 0 | 18 | 0 | 1 (1, 20971) | openai/gpt-6-astra: 1 obs, ratio 0 |
| `l13-three-way` | p0c | 43 | 1068053 | 961629 | 9176 | 0.9 | 1 (1, 37298) | openai/gpt-6-astra: 15 obs, ratio 0.914; openai/gpt-6.1-sol: 15 obs, ratio 0.838; anthropic/claude-opus-5-5: 11 obs, ratio 0.931 |
| `l3-research` | p0a | 15 | 320806 | 235904 | 6583 | 0.735 | 0 (0, 0) | openai/gpt-6-astra: 8 obs, ratio 0.851; opencode-go/deepseek-v4.1-flash: 7 obs, ratio 0.543 |
| `l4-two-fixers` | p0b | 25 | 680128 | 572032 | 3973 | 0.841 | 0 (0, 0) | openai/gpt-6-astra: 12 obs, ratio 0.879; openai/gpt-6.1-sol: 13 obs, ratio 0.806 |
| `l4-two-fixers` | p0d | 24 | 573143 | 504576 | 3853 | 0.88 | 0 (0, 0) | openai/gpt-6-astra: 12 obs, ratio 0.898; openai/gpt-6.1-sol: 12 obs, ratio 0.857 |
| `l5-fixer-designer` | p0c | 34 | 963216 | 861492 | 6764 | 0.894 | 0 (0, 0) | openai/gpt-6-astra: 17 obs, ratio 0.925; openai/gpt-6.1-sol: 8 obs, ratio 0.839; anthropic/claude-opus-5-5: 9 obs, ratio 0.869 |
| `l5-fixer-designer` | p0d | 19 | 461199 | 392192 | 2406 | 0.85 | 0 (0, 0) | openai/gpt-6-astra: 9 obs, ratio 0.868; openai/gpt-6.1-sol: 8 obs, ratio 0.831 |
| `l7-four-areas` | p0a | 46 | 1178914 | 1048192 | 17692 | 0.889 | 0 (0, 0) | openai/gpt-6-astra: 17 obs, ratio 0.916; opencode-go/deepseek-v4.1-flash: 29 obs, ratio 0.866 |
| `l8-dev-server` | p0c | 16 | 469661 | 377984 | 1984 | 0.805 | 1 (1, 14582) | openai/gpt-6-astra: 10 obs, ratio 0.888; openai/gpt-6.1-sol: 6 obs, ratio 0.713 |
| `l9-many-edits` | p0b | 28 | 874924 | 801024 | 3681 | 0.916 | 0 (0, 0) | openai/gpt-6-astra: 7 obs, ratio 0.841; openai/gpt-6.1-sol: 21 obs, ratio 0.934 |

Overall cache-read ratio (summed cache reads / summed input over 15 cases): 0.861
