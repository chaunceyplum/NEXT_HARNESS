# PQL (Profile Query Language) function reference

Captured 19 Sep 2026 from Adobe's own PQL documentation (ported from
intake_harness, where it was first assembled). The AEP knowledge base that
`search_adobe_knowledge` queries does **not** contain this material: a direct
query of the whole 16,106-chunk RAG corpus, across all four indexed domains,
turns up only two segmentation/query-service overview pages and nothing with
actual syntax. This file is that missing syntax. The agent gets it in its
system prompt on every segment/audience run (`lib/llm/segment-context.ts`,
via the generated `lib/llm/pql-reference.ts`), so PQL is written against
real documentation instead of from memory.

Edit this file, then run `node scripts/gen-pql-reference.mjs` to regenerate
`lib/llm/pql-reference.ts`; a unit test fails if the two drift apart.

Source: [PQL overview](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/overview)
and its 12 linked function-category pages (listed per section below). Adobe's
docs are the source of truth — if this file and a live Adobe page disagree,
trust Adobe and update this file.

## Concepts

- **What it is**: "Profile Query Language (PQL) is an Experience Data Model
  (XDM) compliant query language which is designed to support the
  definition and execution of segmentation queries for Real-Time Customer
  Profile data."
- **Expression shape**: every PQL query follows
  `({INPUT_PARAMETER_1}, {INPUT_PARAMETER_2}, ...) => {RESULT_TYPE}`. Input
  parameters can be simple types (booleans, strings) or complex types
  (objects, arrays).
- **Field paths**: three ways to reference a parameter's properties —
  implicit on the first parameter (`homeAddress.stateProvince`), explicit
  positional (`$1`, `$2`, ...), or lambda notation with a named variable
  (`(Profile) => Profile.homeAddress.stateProvince`).
- **Data types**: strings, booleans, integers, doubles, dates
  (`date(year, month, day)`), and arrays (`[...]`).
- **Arrays are not directly indexable**: you cannot access a property of an
  item inside an array by path. Use `select X from array where X.item = ...`
  (or the array/filter functions below) instead.
- **Temporal words are reserved**: relative terms (`now`, `today`,
  `yesterday`, `tomorrow`) and interval units (milliseconds through
  millennia) are part of the grammar, e.g. `X.timestamp occurs last month`.

## Boolean functions

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/boolean-functions)

| Function | Format | Description | Example |
|---|---|---|---|
| `and` | `{QUERY} and {QUERY}` | Logical conjunction | `homeAddress.countryISO = "CA" and person.birthYear = 1985` |
| `or` | `{QUERY} or {QUERY}` | Logical disjunction | `homeAddress.countryISO = "CA" or person.birthYear = 1985` |
| `not` / `!` | `not ({QUERY})` or `!({QUERY})` | Logical negation | `not (homeAddress.countryISO = "CA")` |
| `if` | `if ({TEST}, {TRUE_EXPR}, {FALSE_EXPR})` | Resolve an expression based on a condition | `if (homeAddress.countryISO = "CA", 1, 2)` |

## Comparison functions

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/comparison-functions)

| Function | Description | Example |
|---|---|---|
| `=` | Equals | `homeAddress.countryISO = "CA"` |
| `!=` | Not equal | `homeAddress.countryISO != "CA"` |
| `>` | Greater than | `person.birthMonth > 2` |
| `>=` | Greater than or equal to | `person.birthMonth >= 3` |
| `<` | Less than | `person.birthMonth < 2` |
| `<=` | Less than or equal to | `person.birthMonth <= 2` |

## Array, list, and set functions

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/array-functions)

| Function | Description | Example |
|---|---|---|
| `in` | Item is a member of an array/list | `person.birthMonth in [3, 6, 9]` |
| `notIn` | Item is not a member (excludes nulls) | `person.birthMonth notIn [3, 6, 9]` |
| `intersects` | Two arrays share at least one member | `person.favoriteColors.intersects(["red", "blue", "green"])` |
| `intersection` | The common members of two arrays | `person1.favoriteColors.intersection(person2.favoriteColors) = ["red", "blue", "green"]` |
| `subsetOf` | Array contains all elements of another | `person.favoriteCities.subsetOf(person.visitedCities)` |
| `supersetOf` | Array contains all elements of another (reversed) | `person.eatenFoods.supersetOf(["sushi", "pizza"])` |
| `includes` | Array contains a specific item | `person.favoriteColors.includes("red")` |
| `distinct` | Remove duplicate values | `person.orders.storeId.distinct().count() > 1` |
| `groupBy` | Partition array values by an expression | `xEvent[type="order"].groupBy(storeId)` |
| `filter` | Filter an array by an expression | `person.filter(age >= 21)` |
| `map` | New array by applying an expression to each item | `numbers.map(square)` |
| `topN` | First N items sorted ascending by a property | `orders.topN(price, 5)` |
| `bottomN` | Last N items sorted ascending by a property | `orders.bottomN(price, 5)` |
| `head` | First item in an array | `orders.topN(price, 5).head()` |

## Map functions

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/map-functions)

| Function | Description | Example |
|---|---|---|
| `{MAP}.get({STRING})` | Value for a given key, as an object | `identityMap.get("example@example.com")` |
| `{MAP}.keys()` | All keys, as an array | `identityMap.keys()` |
| `{MAP}.values()` | All values, as an array | `identityMap.values()` |

## String functions

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/string-functions)

| Function | Description | Example |
|---|---|---|
| `like` | Matches a pattern | `city like "%es%"` |
| `startsWith` | Starts with a substring | `person.name.startsWith("Joe")` |
| `doesNotStartWith` | Does not start with a substring | `person.name.doesNotStartWith("Joe")` |
| `endsWith` | Ends with a substring | `person.emailAddress.endsWith(".com")` |
| `doesNotEndWith` | Does not end with a substring | `person.emailAddress.doesNotEndWith(".com")` |
| `contains` | Contains a substring | `person.emailAddress.contains("2010@gm")` |
| `doesNotContain` | Does not contain a substring | `person.emailAddress.doesNotContain("2010@gm")` |
| `equals` | Equal to a string | `person.name.equals("John")` |
| `notEqualTo` | Not equal to a string | `person.name.notEqualTo("John")` |
| `matches` | Matches a regular expression | `person.name.matches("(?i)^John")` |
| `regexGroup` | Extract a capture group from a regex match | `emailAddress.regexGroup("@(\\w+)", 1)` |

## Object functions

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/object-functions)

| Function | Signature | Description | Example |
|---|---|---|---|
| `isNull` | `{OBJECT}.isNull()` | Object reference does not exist | `person.homeAddress.isNull()` |
| `isNotNull` | `{OBJECT}.isNotNull()` | Object reference exists | `person.homeAddress.isNotNull()` |

## Arithmetic functions

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/arithmetic-functions)

| Function | Signature | Description | Example |
|---|---|---|---|
| `+` | `{NUMBER} + {NUMBER}` | Sum | `product1.price + product2.price` |
| `*` | `{NUMBER} * {NUMBER}` | Product | `product.inventory * product.price` |
| `-` | `{NUMBER} - {NUMBER}` | Difference | `product1.price - product2.price` |
| `/` | `{NUMBER} / {NUMBER}` | Quotient | `totalProduct.price / totalProduct.sold` |
| `%` | `{NUMBER} % {NUMBER}` | Remainder | `person.age % 5 = 0` |

## Aggregation functions

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/aggregation-functions)

| Function | Format | Description | Example |
|---|---|---|---|
| `count` | `{ARRAY}.count()` | Number of elements | `orders.count()` |
| `sum` | `{ARRAY}.sum()` | Sum of selected values | `orders.sum(order.price)` |
| `average` | `{ARRAY}.average()` | Arithmetic mean of selected values | `orders.average(order.price)` |
| `min` | `{ARRAY}.min()` | Smallest selected value | `orders.min(order.price)` |
| `max` | `{ARRAY}.max()` | Largest selected value | `orders.max(order.price)` |

## Date and time functions

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/datetime-functions)

| Function | Signature | Description | Example |
|---|---|---|---|
| `currentMonth` | `currentMonth()` | Current month as an integer | `person.birthMonth = currentMonth()` |
| `getMonth` | `{TIMESTAMP}.getMonth()` | Month of a given timestamp | `person.birthdate.getMonth() = 6` |
| `currentYear` | `currentYear()` | Current year as an integer | `product.saleYear = currentYear()` |
| `getYear` | `{TIMESTAMP}.getYear()` | Year of a given timestamp | `person.birthday.getYear() in [1991, 1992, 1993, 1994, 1995]` |
| `currentDayOfMonth` | `currentDayOfMonth()` | Current day of month as an integer | `person.birthDay = currentDayOfMonth()` |
| `getDayOfMonth` | `{TIMESTAMP}.getDayOfMonth()` | Day of month of a given timestamp | `product.sale.getDayOfMonth() <= 15` |
| `occurs` | `{TIMESTAMP} occurs {COMPARISON} {INTEGER} {TIME_UNIT} {DIRECTION} {TIME}` | Compare a timestamp against a fixed period | `product.saleDate occurs last week`; `product.saleDate occurs between date(2015, 1, 8) and date(2017, 7, 1)` |
| `now` | reserved word | Timestamp of PQL execution | `product.saleDate occurs = 3 hours before now` |
| `today` | reserved word | Timestamp of the start of today | `person.birthday occurs = 3 days before today` |

## Filter functions

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/filter-functions)

| Function | Description | Example |
|---|---|---|
| `[]` | Apply a filter to an array, returning matching items | `xEvent[productListItems[SKU="PS"]]` |
| `^` (up operator) | Reference a property at a higher level from inside a nested filter | `xEvent[productListItems[SKU="PS" or ^^.person.gender="female"]]` |

## Logical quantifiers

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/logical-quantifiers)

| Function | Signature | Description | Example |
|---|---|---|---|
| `exists` | `exists {VAR} from {EXPRESSION} where {CONDITION}` | At least one array item satisfies the condition | `exists E from xEvent where (E.commerce.item.price > 50), I from E.productListItems where I.SKU = "PS"` |
| `forall` | `forall {VAR} from {EXPRESSION} where {CONDITION}` | All array items satisfy the condition | `forall E from xEvent where (E.commerce.item.price > 50), I from E.productListItems where I.SKU = "PS"` |

## Miscellaneous functions

[Source](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/pql/misc-functions)

| Function | Signature | Description | Example |
|---|---|---|---|
| `let` | `let {VARIABLE} = {EXPRESSION}` | Store an expression as a variable for later use in the query | `let S = (sum X.commerce.order.priceTotal over X from xEvent where X.commerce.order.currencyCode = "USD") in (S > 100 and S < 1000)` |
