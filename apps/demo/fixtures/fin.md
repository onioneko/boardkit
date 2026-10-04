---
title: Family Finance
stability: volatile
---

# Family Finance

## Now {#now}
```metric
id: cash
label: Cash
source: bank_balance
```
Spend this month: {{source:monthly_spend}}

## Reference
{{include:research/q3-review#summary}}

## Large Purchases
```status
id: dec-macbook
title: Buy MacBook
states: [pending, approved, rejected, executed]
value: pending
note: |
  Old laptop is dead; needed for work. Travel overspend this month.
```

## Follow-ups
```checklist
id: subs
items:
  - id: a
    label: Video platform
    done: false
  - id: b
    label: Cloud storage
    done: true
  - id: c
    label: Buy MacBook
    done: false
```
