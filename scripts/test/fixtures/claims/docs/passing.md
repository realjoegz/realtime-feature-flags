# Passing claims

| Claim | Test |
| --- | --- |
| Addition works | [adds two numbers](../project/tests/sample.test.mjs) |
| Two links, one inside a describe block | [adds two numbers](../project/tests/sample.test.mjs), [a group passes inside a describe block](../project/tests/sample.test.mjs#L8) |
| Backticks around a name | [`adds two numbers`](../project/tests/sample.test.mjs) |

A table without a Test column is not a claim table:

| Name | Value |
| --- | --- |
| a | b |

```md
| Inside a code fence | [is not checked](missing.test.mjs) |
```
