# Airtable’s TypeScript Migration Codemod

The codemod written to migrate the Airtable codebase from Flow to TypeScript.

This codemod was open sourced as a part of publishing the blog post “[**The continual evolution of Airtable’s codebase: Migrating a million lines of code to TypeScript**](https://medium.com/airtable-eng/the-continual-evolution-of-airtables-codebase-migrating-a-million-lines-of-code-to-typescript-612c008baf5c).” If you’re interested in learning more about how Airtable migrated from Flow type TypeScript, we recommend reading that blog post.

> ⚠️ This codemod was designed for one-time use against Airtable’s codebase! If you want to run it against your codebase, you’ll need to clone the git repo and do some manual tuning.

## Architecture

There are two migration scripts:

- `src/modules/run.ts`: For converting CommonJS modules (`require()`, `module.exports`) to ES Modules (`import`, `export`).
- `src/typescript/run.ts`: For converting Flow to TypeScript.

Both codemods use a custom setup where multiple Node.js workers process files in parallel. Practically speaking, [jscodeshift](https://github.com/facebook/jscodeshift) is a great tool which abstracts away parallel codemod workers for you. We chose to write a thin wrapper for more control.

Whenever the codemod detects a case it can’t automatically transform, it reports the file, line, and column to the console. We were able to use this reporting to manually fix many odd patterns in our codebase to help the codemod.

The TypeScript migration (`src/typescript/run.ts`) uses `flow type-at-pos` ([docs](https://flow.org/en/docs/cli/)) to discover what type Flow thinks a variable is when a developer did not add an annotation.

## Changes

What follows is an edited version of our internal documentation which shares, at a high level, the different classes of changes made to the codebase.

This document does not cover the CommonJS to ES Module migration.

(Note: You’ll see references to an `h` and `u` namespace in a couple places throughout this document. These names are placeholders for actual namespaces at Airtable.)

---

# TypeScript Migration: Changes

As a part of the TypeScript migration, a lot of code will change. This document outlines the large classes of changes both automated and manual. The idea is we as an engineering team can review this document instead of reviewing the entire migration diff which would be impossible. There are a couple common goals with all the changes:

* **Don’t break the product.** Always choose to preserve code semantics over anything else.
* **Don’t reduce type safety.** On net, the migration should *increase* type safety. Any large class of automated or manual change will always preserve or increase type safety.
* **Keep it simple.** Migrating requires a lot of changes so keep the changes simple. You should be able to reason about a change in the context of a single file. We can always follow up with smaller migrations for more complex transforms.

Even if some changes eventually become Airtable anti-patterns, they were motivated by these goals so we could safely and timely ship a TypeScript migration.

There are two categories of changes. [Automated](#Automated) changes which were done by a codemod and [Manual](#Manual) changes which were done by hand when a computer couldn’t automatically fix them.

## Automated

You can find the codemod which makes the automated changes in this repo. The function which does all the transformation is `src/typescript/migrate_to_typescript.ts`. The codemod spins up a bunch of processes which transform files in parallel using Babel to parse, [Recast](https://github.com/benjamn/recast) to print, and Babel utilities to traverse the AST. This is a similar architecture to [jscodeshift](https://github.com/facebook/jscodeshift) but hand-rolled to provide custom file discovery logic and to be more thorough with AST transformations.

### File extensions

All files with an `// @flow` annotation will be converted to TypeScript. The file extension will be changed to `.ts` or `.tsx` if the file has JSX in it. It’s worth considering if, as part of the Airtable style guide, whether we should name all files with a `.tsx` extension for consistency.

### Utility type transformations

* `mixed` → `unknown`
* `empty` → `never`
* `Object` → `FlowAnyObject`
    The `Object` type is just an alias for `any` in Flow. There’s a little bit of unimportant history to this type, what’s important is that it’s `any` now. The codemod will transform it to `FlowAnyObject` instead of `any` directly since a type alias preserves the author’s intent.
* `Function` → `FlowAnyFunction`
    Same story as `Object`, it is an alias for `any` in Flow.
* `$ReadOnlyArray<T>` → `ReadonlyArray<T>`
* `$Keys<T>` → `keyof T`
* `$Values<T>` → `h.ObjectValues<T>`
    We use a utility type defined in the `h` namespace which is implemented as `T[keyof T]`. We don’t transform to that directly because it would require writing `T` twice which is annoying if `T` is a really long name.
* `$Shape<T>` → `Partial<T>`
* `$PropertyType<T, K>` → `T[K]`
* `$ElementType<T, K>` → `T[K]`
    The difference between `$PropertyType` and `$ElementType` in Flow is that `$PropertyType` requires a single static string key, so `$PropertyType<O, 'foo' | 'bar'>` is not allowed. They use slightly different code paths in Flow’s codebase. The difference is mostly for historical reasons and kinda annoying.
* `*` → `FlowAnyExistential`
    Flow [existential types](https://flow.org/en/docs/types/utilities/#toc-existential-type) are deprecated. They basically behave as `any`. There’s more context and history here for those interested.
* `$Subtype<T>` → `any`
    Also a [deprecated type](https://flow.org/en/docs/types/utilities/#toc-subtype). Should probably add an alias like `FlowAnyObject`.
* `React.Node` → `React.ReactNode`
* `React.Element<P>` → `React.ReactElement<React.ComponentProps<P>>`
    TypeScript’s React types accept a component type in `React.ReactElement` instead of the props type like Flow.

### Object index types other than string or number

This change is pretty important (since it happens a lot) and a bit unfortunate. Flow supports any type as the indexer of an object. For example `{[key: UserId]: string}`. However, TypeScript only supports `string` or `number` index keys and does not allow types that are literally aliases for `string` or `number`. So even though in our codebase ID types are written as `type UserId = string` we can’t use them as an indexer type in TypeScript.

So the codemod adds a utility type `h.ObjectMap<K, V>` which allows you to write `h.ObjectMap<UserId, string>`. That will preserve the developer’s intent with the Flow type `{[UserId]: string}`. `h.ObjectMap` has a simple implementation using a TypeScript feature called [mapped types](http://www.typescriptlang.org/docs/handbook/advanced-types.html#mapped-types): `type ObjectMap<K, V> = {[_K in K]: V}`. You can also use `h.ObjectMap` if you have a string union (like an enum type) so `h.ObjectMap<AccessPolicy, T>`. This is a bit different than Flow since TypeScript will make all of the properties required. If you’d like the properties to be optional you can use `Partial<h.ObjectMap<AccessPolicy, T>>` which desugars to `{[P in AccessPolicy]?: T}`.

TypeScript actually includes a utility type with the same definition as `h.ObjectMap` called [`Record`](http://www.typescriptlang.org/docs/handbook/utility-types.html#recordkt). Given our domain model at Airtable, I figured using the name `Record` would be too confusing for developers.

A lot of places using `h.ObjectMap` in Hyperbase could be using an ES6 [map](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map). An ES6 map is better for type checking and better for performance. If we end up making our ID types nominal (so `RowId` can’t be passed somewhere expecting a `ColumnId`) then `h.ObjectMap` might not work but an ES6 map would work.

We as an engineering team have to make a couple decisions:

* Should we discourage use of `h.ObjectMap` and recommend directly writing a mapped type (`{[_K in K]: V`) or directly writing an indexer type (`{[key: string]: V}`)?
* Should we encourage replacing usages of `h.ObjectMap` with an ES6 map?
* Should we name `h.ObjectMap` something longer to discourage people from using it?

### Object spread types

Object types with a spread like `{a: A, ...T, b: B}` will be turned into intersection types like `{a: A} & T & {b: B}` since TypeScript doesn’t have object type spread. The reason why intersection types weren’t enough for Flow is that there were small very edge-case type rules Flow didn’t want to compromise on. Intersections are perfectly acceptable for this in TypeScript.

Most of the cases where we were using object spread types, though, we should probably use `interface` and `extends` going forward. The type checking of `interface`s is easier to understand and `interface`s have better IDE tooling support.

### Object readonly properties

Object properties which have a `+` like `{+p: T}` are readonly so we convert them to readonly TypeScript properties like `{readonly p: T}`. Technically, you can also have “writeonly” properties in Flow with `-` like `{-p: T}` but that never shows up in our codebase.

### Unnamed arguments in function types

Flow permits arguments in function types to be unnamed. For example, `(T, U) => V`. TypeScript requires function types to have argument names, though. So the codemod will transform unnamed function type arguments to an `argN` form like `(arg1: T, arg2: U) => V`. (Starts at one instead of zero because humans start counting from one.)

Unnamed rest arguments like `(...Array<T>) => U` will be named `rest` as in `(...rest: Array<T>) => U`.

Unnamed indexer properties like `{[string]: T}` will be named `key` as in `{[key: string]: T}`.

### Maybe types and optional function parameters

The Flow maybe type `?T` will be transformed into `T | null | undefined`. If the maybe type is part of a function parameter like `function f(x: ?T)` then it will be transformed into `function f(x?: T | null)`.

If a function parameter included a union with undefined like `function f(x: T | void)` it will be transformed into an optional parameter `function f(x?: T)`. Flow treats types which can accept `undefined` as optional, but TypeScript requires a parameter to be marked as optional.

If an optional parameter comes before a required parameter then we make the optional parameter required. For example `function f(x?: T, y: U)` is allowed in Flow but not in TypeScript so we will change it to `function f(x: T | undefined, y: U)`.

If an optional parameter also has a default value then we remove the optional mark since TypeScript complains. For example `function f(x?: T = y)` will be transformed into `function f(x: T = y)`.

### Type imports

Flow has syntax for specifically importing types: `import type {UserId} from '...'`. This will be converted to a normal ES import: `import {UserId} from '...'`. The only difference is removing the `type` keyword.

The Babel plugin for TypeScript will completely remove imports that only import types, so we don’t have to worry about regressing bundle size or introducing cycles.

### Unannotated function parameters

In TypeScript, function parameters whose type is not immediately known require a type annotation. For example: `function f(x)` requires a type annotation for `x` but `a.map(b => { ... })` does not require a type annotation for `b` since the type is immediately known (`a` is an array type).

For unannotated function parameters that require a type annotation we [try to get Flow’s inferred type](https://github.com/Airtable/typescript-migration-codemod/blob/src/typescript/flow_type_at_pos.ts) by running `flow type-at-pos`. We do not use the type if it is longer than 100 characters (since a human probably would not have written that type).

If we get `any` from Flow **we rename it to `FlowAnyInferred`** so that the programmer knows “we asked Flow what type it thought this was and Flow said `any`.” Flow ends up inferring `any` a lot for unannotated function parameters. That’s because in order to infer a type for unannotated function parameters, Flow needs to see a call for that function *in the same file* that the function was defined. If Flow does not see a call in the same file it treats the parameter as `any`.

Specifically, we use `flow type-at-pos` to infer function parameter types for:

* Function declarations (`function f(x)`). Notably not function expressions, we will manually annotate those.
* Class methods (`class C {m(x) {...}`).
* Object methods but *only* in `createReactClass()` (`createReactClass({m(x) {...}})`). We will manually annotate unannotated methods in crud managers.

If `flow type-at-pos` doesn’t give us a type then we will manually annotate.

### Type cast expressions

Flow has an expression type cast syntax which looks like `(x: T)`. TypeScript has a similar type cast syntax which looks like `(x as T)`. They don’t have the same behavior! TypeScript as-expressions allow for [downcasting](https://en.wikipedia.org/wiki/Downcasting) whereas Flow type cast expressions do not. We introduce a `u.cast<T>(x)` utility which doesn’t allow downcasting as part of the codemod, but we will transform many of the common cases to as-expressions. Here are the rules:

* `((x: any): T)` is pretty frequently used in Hyperbase to downcast a type. We transform this into `(x as T)`. Except if we are in a `createReactClass()` object property, then we will transform it into `((x as any) as T)` since React code uses this syntax to declare the type of variables which will be initialized in `componentWillMount`.
* `(x: any)` is transformed into `(x as any)` since that’s no different than using `u.cast()`.
* `('foo': 'foo')` is transformed into `('foo' as const)`. This is pretty common with our `Object.freeze()` enum syntax. In TypeScript, `as const` will tell the type checker: “infer this type knowing I’m never going to mutate it.” Notably, this means you don’t have to type string literals like `'foo'` twice anymore!
* `(x: T)` when `x` is a literal like `null` or `[]` we transform it to `(x as T)`. That’s because `(null: T | null)` or `([]: Array<T>)` is used a lot to widen the type for an empty value in something like `getInitialState()`.

If none of these cases apply then we transform `(x: T)` to `u.cast<T>(x)` which preserves type safety.

### Implicit anys in test file variables

There are a couple common patterns in the codebase where TypeScript requires a type annotation that Flow doesn’t, notably for this transform: `let x`, `let x = {}`, and `let x = []`. Flow is supposedly able to infer a type for these variables although it often gets it wrong and ends up using `any`. In all of our non-test files the correct type was manually added. In test files, however, the codemod will add an explicit `any`. For example `let x: any`.

Also, if we can’t get Flow’s inferred type for an unannotated function parameter (using the process described in [Unannotated Function Parameters](#unannotated-function-parameters)) we will annotate the parameter as `any` in test files only.

The principle here is that it’s ok for test files to be less type safe. Test file type safety is practically guaranteed given that they run in CI all the time. It would be very tedious to manually pick the right type for every case of this for little type safety value. Introducing this transform in the codemod fixed ~10k errors. For context, ~15k errors will be manually fixed.

As a part of this change, the eslint rule that warns when it sees an `any` is disabled in test files.

### Suppression comments

`// flow-disable-next-line` will be transformed into `// @ts-ignore`.

`// eslint-disable-line flowtype/no-weak-types` will be transformed into `// eslint-disable-line @typescript-eslint/no-explicit-any`.

### Opaque types

[Opaque type aliases](https://flow.org/en/docs/types/opaque-types) will be converted into normal type aliases. It’s a bit unfortunate that TypeScript doesn’t support opaque type aliases ([yet](https://github.com/microsoft/TypeScript/pull/33038)), but you can get the same behavior through a variety of means. We only have five opaque type aliases and they are all written by the same person.

## Manual

All the manual changes were done by one engineer so in this part of the document I’ll be using first person. When deciding how to manually fix ~15k errors I leaned pretty heavily on the migration goals listed at the beginning of the document: **don’t break the product**, **don’t reduce type safety**, **keep it simple**.

In this section I’ll list major categories of manual fixes. I may miss or skip some smaller categories. You can find and review all my manual fixes in a single commit (~1.6k files out of ~3.3k TypeScript files have manual changes). It’s worth noting that I’m a bit scared of bugs introduced by manual fixes. All the bugs I found when fixing the Airbuild test suite were from manual fixes. A diff of the compiled output should give us visibility into where manual fixes changed code semantics.

### Adding extra Annotations

Perhaps the larges class of manual fixes was adding extra type annotations. TypeScript errors when a type is under annotated. Most of the time this would occur with an empty object, empty array, or empty variable (`let x = null`) that is later mutated. Common patterns I’d see:

```
const x = {};
const x = [];
let x = null;

new Set(); // infers Set<unknown>
new Promise(); // infers Promise<unknown>

shardingHelper.mapReduceAsync(); // infers unknown for map/reduce result types
```

If I couldn’t find a type or I believed Flow inferred `any` I’d use the `FlowAnyInferred` type alias which was introduced for [Unannotated Function Parameters](#unannotated-function-parameters).

For objects, it’s worth noting how I picked between `{[key: string]: T}`, `h.ObjectMap<K, T>`, and `{[_K in K]: T}` (see [Object Index Types Other Than String Or Number](#object-index-types-other-than-string-or-number) for some more context on the differences). Maybe we should encode this in the style guide? The decision tree is unforuntately a bit complicated.

* If the key is exactly `string` and not a type alias use `{[key: string]: T}`.
* If the key should really be an object ID like `UserId` or `RecordId` use `h.ObjectMap<UserId, T>`.
* If the key is a string union or a generic string type (like `IdT`) and the properties need to be optional use `{[_K in K]?: T}`. Although, now I regret that decision and wish I used `Partial<h.ObjectMap<K, T>>` which is more consistent.

### Suppression comment policy

Suppression comments (`// @ts-ignore` in TypeScript) are scary because the silence all errors on a line of code. However, sometimes it made sense to use a suppression comment anyway. This section documents my policy on when to use a suppression comment vs. `any` or some other tactic.

First off, all suppression comments manually added in the TypeScript migration begin with `#typescript-migration`. This way you can search through the files you own and cleanup suppression comments. I manually added ~2.5k suppressions, for context: I manually edited ~1.6k files and there are ~3.3k TypeScript files. Some suppression comments address a specific issue, they are:

* `#typescript-migration-implicit-any`: [Implicit Anys Where The Type Could Be Immediately Known](#implicit-anys-where-the-type-could-be-immediately-known)
* `#typescript-migration-react-null-prop`: [React Null Props](#react-null-props)

I would add a generic `// @ts-ignore #typescript-migration` suppression comment when:

* Fixing the error would require semantic changes which couldn’t be implemented or verified in a space of about five lines. I’d make really small, simple, and locally verifiable changes that didn’t require running the app but that’s it.
* Fixing the error with an `any` would make the code less type safe.
* It’s an unfortunate incompatibly between TypeScript and Flow without a clear fix.

I would first try to change the types (type changes are verifiable by running TypeScript), if I couldn’t do that then I’d use a suppression comment.

### Implicit anys where the type could be immediately known

In [Unannotated Function Parameters](#unannotated-function-parameters) I mentioned that function expressions (like arrow functions) with unannotated function parameters I left alone since usually the type is immediately knowable by TypeScript. For example:

```
x.map(y => y + 1)
```

If `x` is `Array<number>` then TypeScript immediately knows `y` must be `number`. Roughly how this rule works: if TypeScript knows the type of an expression at the point where the expression is defined it can use that type to infer some types in that expression. This is a pretty common trick in programming language design, especially programming languages with lambda expressions ([Rust example](https://play.rust-lang.org/?version=stable&mode=debug&edition=2018&gist=11de40bcf730295161cf740f390a96af), [TypeScript example](http://www.typescriptlang.org/play/index.html#code/PTAEHkGsCgBsFMAuoBmAuUAKAHhgdgK4C2ARvAE4CUoAvAHyiGkW2ja0PsDUoAjANzRoIUAFFy5APbk4SUAHNW7em1A8B0IA)).

However, in our example above if `x` is `any` then we don’t immediately have a type for `y`, so TypeScript complains that `y` needs a type annotation. This happens pretty commonly with `h.async` since it’s typed as `any`. There are two possible fixes:

1. Annotate `y` with `any`.
2. Add a `@ts-ignore` comment to suppress the error.

The problem with option 1 is that it locks in the type of `y` forever. If `x` is ever changed from `any` to `Array<number>` then `y` will still forever be `any` instead of `number`. So instead I went with option 2 in most cases and added a `// @ts-ignore #typescript-migration-implicit-any` comment for unannotated arrow expression parameters that *could* be immediately known if we had more type safety. That way if `x` is one day typed `y` will be `number` and the `@ts-ignore` comment can be safely removed.

This is especially important for uses of `h.async`. Code using `h.async` ends up looking like:

```
h.async.series([
  // @ts-ignore #typescript-migration-implicit-any
  next => {...},

  // @ts-ignore #typescript-migration-implicit-any
  (x, next) => {...},

  // @ts-ignore #typescript-migration-implicit-any
  (y, next) => {...},

  // @ts-ignore #typescript-migration-implicit-any
  (z, next) => {...},
]);
```

That’s only because `h.async` is `any`, though. One day if we add proper types to `h.async` we can remove all these suppression comments. They’re also really easy to search for since they use a specific name.

### Create react class improvements

I wrote custom types for `createReactClass()` that balance our needs to express `EventListenerMixin`. It increases type coverage, compared to Flow, since `this.props` and `this.state` are properly typed. Prop types are inferred from `propTypes` and the state type is inferred from `getInitialState()`.

In cases where prop types are too general I used something like `PropTypes.object.isRequired as PropTypes.Validator<CustomObject>` which gives the prop type the `CustomObject` type instead of a generic object.

### Reassignment does not change variable type

A common pattern in our codebase is:

```
function doThing(opts?: {someOption?: number}) {
  opts = u.setAndEnforceDefaultOpts({
    someOption: 0,
  }, opts);
}
```

`u.setAndEnforceDefaultOpts()` returns `any` so Flow gives `opts` a type of `any`. But this control flow analysis is difficult to do in general, so TypeScript keeps the type that `opts` was annotated with which is `{someOption?: number} | undefined`. That means when you try to access `opts.someOption` TypeScript will error complaining that `opts` is `undefined`. The fix I went with was to change the code to:

```
function doThing(_opts?: {someOption?: number}) {
  const opts = u.setAndEnforceDefaultOpts({
    someOption: 0,
  }, _opts);
}
```

Rename the `opts` parameter to `_opts` and set the result of `u.setAndEnforceDefaultOpts()` to a new variable. Technically, I’d classify this as a semantics change, but it’s small and locally verifiable so I’m ok with it.

I’m calling out `u.setAndEnforceDefaultOpts()` because this issue happened a lot with that utility, but I saw this class of issue elsewhere too. Particularly in column type providers where a value would start as `unknown` and would be reassigned to more a specific type like `number`.

### Class fields which are not initialized in the constructor

TypeScript requires all class fields to be initialized in the constructor. In Hyperbase we commonly see a pattern like this:

```
class MyClass {
  someField: number;

  constructor() {
    this.reset();
  }

  reset() {
    this.someField = 42;
  }
}
```

This is an error in TypeScript since `someField` is not initialized in the constructor. When I saw this I’d either:

* Change the property to an optional property like `someField?: number` if it was truly optional.
* Suppress the field with an `// @ts-ignore #typescript-migration` comment since it’s an unfortunate incompatibility between Flow and TypeScript.

### Non-null assertions on u.head, u.last, and others

Some functions like `u.head()` and `u.last()` returned just `T` in Flow. That’s incorrect since it doesn’t account for the empty array case. In TypeScript they return `T | undefined`. Almost everywhere we use `u.head()` and `u.last()` we first check that the list is non-empty so adding a non-null assertion (`u.last()!`) is fine.

This also happens for a couple other utilities like `u.maxBy()`, but most notably for every usage of `u.head()` and `u.last()`.

### Property access with string on a more specific type

An error I saw a lot was when we use a `string` to [index a type with known properties](http://www.typescriptlang.org/play/index.html#code/CYUwxgNghgTiAEYD2A7AzgF3kgXPA3gFDwnwBmSu8KArgLYBGIMANMaQ7HrY826fACONAB7d6TVoQC+AbkKFQkWAmTosABzyYYASxQBzeYSQBtDQF15QA).

```
type O = {
  foo: number,
  bar: number,
  qux: number,
};

declare const o: O;
declare const p: string;

o[p]; // Error!
```

The solution here really depends on the context. The basic strategy was to get the type of `p` to be `keyof O`. Sometimes you can do by changing annotations. Sometimes I’d use `p as keyof O` because you could locally verify the property exists since there’s a `u.has()` check.

```
if (u.has(o, p)) {
  o[p]; // Still an error, but actually safe.
}
```

Flow would [implicitly return `any` in these cases](https://flow.org/try/#0CYUwxgNghgTiAEA3W8D2AueBvAUPf8AZqhvAHYCuAtgEYgwA0eBNsmlt9TB8AjhQA921OoxwBfANw4coSLATIY8AA6YAzgBcYASzIBzaTlQBtFQF0AdAE9UEVJPgB6J-ADyAa3g0Km+KEI9HU0QCGt4dQALVAoIYDJATAI-OhwgA).

### React null props

Unfortunately, the TypeScript types for React (`@types/react`) don’t support `null` everywhere they could. For example, the following are all errors:

```
<div
  role={enabled ? 'button' : null}
  onClick={enabled ? handleClick : null}
  style={{
    backgroundColor: enabled ? 'tomato' : null,
  }}
>
  ...
</div>
```

The fix here is to use `undefined` instead, but since that would be a semantics change that is not locally verifiable (what if some else uses this prop type?) and changing the types would require forking `@types/react` I chose to suppress these cases instead with `// @ts-ignore #typescript-migration-react-null-prop`.

We can follow up after the migration by picking a path forward (either forking `@types/react` or using `undefined`) and remove all the instances of `#typescript-migration-react-null-prop`. At the moment I’m not ready to add the complexity of doing either (forking a popular library vs. semantics change) to the migration.

### Untyped imports used in type positions

Sometimes, with Flow we use imports from untyped modules in a type position. For example when the `quill-delta` module is untyped:

```
import QuillDelta from 'quill-delta';

function doThing(delta: QuillDelta) {...}
```

This is an error in TypeScript, so I change this pattern to:

```
import QuillDelta from 'quill-delta';
type QuillDelta = FlowAnyUntypedModuleImport;

function doThing(delta: QuillDelta) {...}
```

Which is an alias for `any` and easy to search for. When you add types for `quill-delta` you can search for `type QuillDelta = FlowAnyUntypedModuleImport` and simply delete it.

I developed this strategy a bit later in the manual migration and tried to retroactively move to this style but might have missed some cases. (Which likely use a suppression comment instead.)

### ref to a create react class component

For example when you have the following component where `DateCellTimeInput` is created by `createReactClass()`:

```
const DateCellEditor = createReactClass({
  _timeInput: (null as DateCellTimeInput | null),
  // ...
});
```

You can’t actually use `DateCellTimeInput` as a type here since it’s a value (created by `createReactClass()`). Flow had special support for this. The fix here is to introduce a utility type `h.ReactRefType` which gets the type of a `createReactClass()` instance.

```
const DateCellEditor = createReactClass({
  _timeInput: (null as h.ReactRefType<typeof DateCellTimeInput> | null),
  // ...
});
```

### Accessing a property on never

A common pattern for exhaustive pattern match checking in Hyperbase is (in Flow syntax):

```
switch (field.type) {
  // handle all the cases...

  default:
    throw u.spawnUnknownSwitchCaseError('type', (field.type: empty));
}
```

In TypeScript syntax after applying the rules in [Type Cast Expressions](https://airtable.quip.com/fDW5ADa1hPW1#GKbACA7vA6n):

```
switch (field.type) {
  // handle all the cases...

  default:
    throw u.spawnUnknownSwitchCaseError('type', u.cast<never>(field.type));
}
```

The logic here is that TypeScript or Flow will type `field` as the bottom type (`never` or `empty` respectively) if all other cases have been handled. However, TypeScript does not allow properties to be accessed on a `never` type so `field.type` errors. The fix here is to write `u.cast<never>(field)['type']` since TypeScript does allow index accesses on `never`.

**Recommendation:** to make exhaustive switches really easy to write we can add a utility like:

```
function spawnExhaustiveSwitchError(value: never) {
  if (typeof value === 'object' && value !== null) {
    // Infer sentinel field by looking for common property names:
    // type, kind, method, etc.
  } else {
    // Return error...
  }
}
```

That means all you need in an exhaustive switch like the one above is:

```
default:
  throw u.spawnExhaustiveSwitchError(field);
```

### Destructured class imports

In a couple places we’d have a file which (after the ES Module migration) looks like this…

```
class MyClass {...}

export default {
  MyClass,
  someConstant: 42,
};
```

…and is then used like this…

```
import _myClass from 'client_server_shared/my_class';
const {MyClass, someConstant} = _myClass;

function f(x: MyClass) {...}
```

This breaks TypeScript’s ability to use `MyClass` as a type since instead of being introduced into scope in import-land it is introduced into scope in value-land. The fix is to use a named export instead of a default export like this:

```
export class MyClass {...}

export const someConstant = 42;
```

So when TypeScript required this change, I manually made it.

Destructed default imports are a consequence of migrating to ES Modules without changing the semantics of our code. We’ll probably want to recommend a different style of imports/exports eventually. In the meantime, however, I needed to manually migrate some modules to named exports.

### Accessing untyped properties on global objects

I’d convert code like `global[sdkVariableName]` to `(global as any)[sdkVariableName]` since in TypeScript, `global` is typed.

### `this.constructor` is untyped

In a class `this.constructor` is typed as `Function`. The TypeScript team is [interested in changing this](https://github.com/microsoft/TypeScript/issues/3841) but for now some of our abstractions are affected.

I ended up adding a suppression comment in this case since there it’s a TypeScript incompatibility without a clear fix.
