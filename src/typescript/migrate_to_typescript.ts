import * as t from '@babel/types';
import traverse, {NodePath} from '@babel/traverse';
import MigrationReporter from './migration_reporter';
import flowTypeAtPos from './flow_type_at_pos';

export default function migrateToTypeScript(
    reporter: MigrationReporter,
    filePath: string,
    file: t.File,
    fileStats: {hasJsx: boolean},
): Promise<unknown> {
    // We insert `any` more frequently when migrating a test file.
    const isTestFile = filePath.endsWith('.test.js');

    let shouldImportUtils = false;

    function importUtils(path: NodePath<t.Node>): t.Expression {
        if (!path.scope.hasBinding('u')) {
            shouldImportUtils = true;
        }
        return t.identifier('u');
    }

    const awaitPromises: Array<Promise<unknown>> = [];

    traverse(file, {
        Program: {
            exit(path) {
                // If we need to import the `h`/`u` utilities then add an import declaration to the
                // top of the program.
                if (shouldImportUtils) {
                    path.node.body.unshift(t.importDeclaration(
                        [t.importDefaultSpecifier(t.identifier('u'))],
                        t.stringLiteral('client_server_shared/u'),
                    ));
                }
            },
        },

        /* -------------------------------------------------------------------------------------- *\
        |  Type Annotations                                                                        |
        \* -------------------------------------------------------------------------------------- */

        TypeAnnotation(path) {
            // Flow automatically makes function parameters that accept `void` not required.
            // However, TypeScript requires a parameter even if it is marked as void. So make all
            // parameters that accept `void` optional.
            if (
                path.parent.type === 'Identifier' &&
                path.parentPath.parent.type !== 'VariableDeclarator'
            ) {
                // `function f(x: ?T)` → `function f(x?: T | null)`
                if (path.node.typeAnnotation.type === 'NullableTypeAnnotation') {
                    path.parent.optional = true;

                    const nullableType = t.unionTypeAnnotation([
                        path.node.typeAnnotation.typeAnnotation,
                        t.nullLiteralTypeAnnotation(),
                    ]);
                    inheritLocAndComments(path.node.typeAnnotation, nullableType);
                    path.node.typeAnnotation = nullableType;
                }

                // `function f(x: T | void)` → `function f(x?: T)`
                if (
                    path.node.typeAnnotation.type === 'UnionTypeAnnotation' &&
                    path.node.typeAnnotation.types.some(unionType => unionType.type === 'VoidTypeAnnotation')
                ) {
                    path.parent.optional = true;
                    path.node.typeAnnotation.types =
                        path.node.typeAnnotation.types.filter(unionType => unionType.type !== 'VoidTypeAnnotation');
                }
            }

            replaceWith(
                path,
                t.tsTypeAnnotation(migrateType(reporter, filePath, path.node.typeAnnotation)),
            );
        },

        TypeParameterDeclaration(path) {
            replaceWith(
                path,
                migrateTypeParameterDeclaration(reporter, filePath, path.node),
            );
        },

        /* -------------------------------------------------------------------------------------- *\
        |  Declarations and Statements                                                             |
        \* -------------------------------------------------------------------------------------- */

        ImportDeclaration(path) {
            // `import type {...} from` => `import {...} from`
            if (path.node.importKind === 'type') {
                path.node.importKind = 'value';
                return;
            }

            // `import typeof X from` => ???
            if (path.node.importKind === 'typeof') {
                // noop, fix manually
                return;
            }

            // `import {...} from`
            if (!path.node.importKind || path.node.importKind === 'value') {
                // `import {type X} from` => `import {X} from`
                for (const specifier of path.node.specifiers) {
                    if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') {
                        specifier.importKind = null;
                    }
                }

                return;
            }

            throw new Error(`Unrecognized import kind: ${JSON.stringify(path.node.importKind)}`);
        },

        ExportNamedDeclaration(path) {
            delete path.node.exportKind;
        },

        TypeAlias(path) {
            replaceWith(path, t.tsTypeAliasDeclaration(
                path.node.id,
                path.node.typeParameters
                    ? migrateTypeParameterDeclaration(reporter, filePath, path.node.typeParameters)
                    : null,
                migrateType(reporter, filePath, path.node.right),
            ));
        },

        OpaqueType(path) {
            if (path.node.supertype)
                throw new Error('Opaque types with a supertype are currently not supported.');

            // Currently we just drop the `opaque` from an opaque type alias. We have only a few
            // opaque types so this is unfortunate, but acceptable. We can manually migrate to a
            // similar form.
            replaceWith(path, t.tsTypeAliasDeclaration(
                path.node.id,
                path.node.typeParameters
                    ? migrateTypeParameterDeclaration(reporter, filePath, path.node.typeParameters)
                    : null,
                migrateType(reporter, filePath, path.node.impltype),
            ));
        },

        InterfaceDeclaration(path) {
            if (path.node.mixins && path.node.mixins.length > 0)
                throw new Error('Interface `mixins` are unsupported.');
            if (path.node.implements && path.node.implements.length > 0)
                throw new Error('Interface `implements` are unsupported.');

            const typeParameters = path.node.typeParameters
                ? migrateTypeParameterDeclaration(reporter, filePath, path.node.typeParameters)
                : null;

            const extends_ = path.node.extends ? (
                path.node.extends.map(flowExtends => {
                    const tsExtends = t.tsExpressionWithTypeArguments(
                        migrateQualifiedIdentifier(flowExtends.id),
                        flowExtends.typeParameters
                            ? migrateTypeParameterInstantiation(
                                reporter,
                                filePath,
                                flowExtends.typeParameters
                            )
                            : null,
                    );
                    inheritLocAndComments(flowExtends, tsExtends);
                    return tsExtends;
                })
            ) : null;

            const body = migrateType(reporter, filePath, path.node.body);
            if (body.type !== 'TSTypeLiteral')
                throw new Error(`Unexpected AST node: ${JSON.stringify(body.type)}`);

            replaceWith(path, t.tsInterfaceDeclaration(
                path.node.id,
                typeParameters,
                extends_,
                t.tsInterfaceBody(body.members),
            ));
        },

        VariableDeclarator(path) {
            // `let x;` → `let x: any;`
            // `let x = {};` → `let x: {[key: string]: any} = {};`
            // `let x = [];` → `let x: Array<any> = [];`
            //
            // TypeScript can’t infer the type of an unannotated variable unlike Flow. We accept
            // lower levels of soundness in test files. We’ll manually annotate non-test files.
            if (isTestFile) {
                if (
                    path.parent.type === 'VariableDeclaration' &&
                    path.parentPath.parent.type !== 'ForStatement' &&
                    path.parentPath.parent.type !== 'ForInStatement' &&
                    path.parentPath.parent.type !== 'ForOfStatement' &&
                    path.node.id.type === 'Identifier' &&
                    path.node.id.typeAnnotation == null
                ) {
                    if (path.node.init === null) {
                        path.node.id.typeAnnotation = t.tsTypeAnnotation(t.tsAnyKeyword());
                    } else if (
                        path.node.init.type === 'ObjectExpression' &&
                        path.node.init.properties.length === 0
                    ) {
                        path.node.id.typeAnnotation = t.tsTypeAnnotation(t.tsTypeLiteral([
                            t.tsIndexSignature(
                                [tsIdentifier(
                                    'key',
                                    null,
                                    t.tsTypeAnnotation(t.tsStringKeyword()),
                                )],
                                t.tsTypeAnnotation(t.tsAnyKeyword()),
                            )
                        ]));
                    } else if (
                        path.node.init.type === 'ArrayExpression' &&
                        path.node.init.elements.length === 0
                    ) {
                        path.node.id.typeAnnotation = t.tsTypeAnnotation(t.tsTypeReference(
                            t.identifier('Array'),
                            t.tsTypeParameterInstantiation([t.tsAnyKeyword()]),
                        ));
                    }
                }
            }
        },

        FunctionDeclaration: {
            enter(path) {
                // Add Flow’s inferred type for all unannotated function parameters...
                awaitPromises.push(annotateParamsWithFlowTypeAtPos(reporter, filePath, path.node.params));

                // `function f(x, y, z)` → `function f(x: any, y: any, z: any)`
                //
                // TypeScript can’t infer unannotated function parameters unlike Flow. We accept lower
                // levels of soundness in type files. We’ll manually annotate non-test files.
                if (isTestFile) {
                    for (const param of path.node.params) {
                        if (!(param as any).typeAnnotation) {
                            (param as any).typeAnnotation = t.tsTypeAnnotation(t.tsAnyKeyword());
                        }
                    }
                }
            },
            exit(path) {
                let optional = true;

                // `function f(a?: T, b: U)` → `function f(a: T | undefined, b: U)`
                for (const param of path.node.params.slice().reverse()) {
                    let paramIsOptional = false;
                    if (param.type === 'AssignmentPattern') {
                        paramIsOptional = true;
                        if (param.left.type === 'Identifier' && param.left.optional) {
                            param.left.optional = false;
                        }
                    }
                    if (param.type === 'Identifier' && param.optional) {
                        paramIsOptional = true;
                    }
                    if (!paramIsOptional) {
                        optional = false;
                    } else {
                        if (!optional) {
                            const identifier = (param.type === 'AssignmentPattern' ? param.left : param) as t.Identifier;
                            delete identifier.optional;

                            if (identifier.typeAnnotation && identifier.typeAnnotation.type === 'TSTypeAnnotation') {
                                if (identifier.typeAnnotation.typeAnnotation.type === 'TSUnionType') {
                                    identifier.typeAnnotation.typeAnnotation.types.push(t.tsUndefinedKeyword());
                                } else {
                                    identifier.typeAnnotation.typeAnnotation = t.tsUnionType([
                                        identifier.typeAnnotation.typeAnnotation,
                                        t.tsUndefinedKeyword(),
                                    ]);
                                }
                            }
                        }
                    }
                }
            },
        },

        ClassProperty(path) {
            // `class { +prop: boolean }` => `class { readonly prop: boolean }`
            // the typescript decls for ClassProperty don't have variance for some reason
            const nodeAsAny = path.node as any;
            if (nodeAsAny.variance && nodeAsAny.variance.kind === 'plus') {
                nodeAsAny.variance = null;
                nodeAsAny.readonly = true;
            }
        },

        ClassMethod(path) {
            // Add Flow’s inferred type for all unannotated function parameters...
            awaitPromises.push(annotateParamsWithFlowTypeAtPos(reporter, filePath, path.node.params));
        },

        ObjectMethod(path) {
            if (isInsideCreateReactClass(path)) {
                // Add Flow’s inferred type for all unannotated function parameters...
                awaitPromises.push(annotateParamsWithFlowTypeAtPos(reporter, filePath, path.node.params));
            }
        },

        /* -------------------------------------------------------------------------------------- *\
        |  Expressions                                                                             |
        \* -------------------------------------------------------------------------------------- */

        TypeCastExpression(path) {
            if (
                // `((x: any): T)` → `(x as T)`
                // `((x: Object): T)` → `(x as T)`
                // `((x: Function): T)` → `(x as T)`

                path.node.expression.type === 'TypeCastExpression' &&
                (path.node.expression.typeAnnotation.typeAnnotation.type === 'AnyTypeAnnotation' ||
                    (path.node.expression.typeAnnotation.typeAnnotation.type === 'GenericTypeAnnotation' &&
                    path.node.expression.typeAnnotation.typeAnnotation.typeParameters &&
                        path.node.expression.typeAnnotation.typeAnnotation.id.type === 'Identifier' &&
                        (path.node.expression.typeAnnotation.typeAnnotation.id.name === 'Object' ||
                            path.node.expression.typeAnnotation.typeAnnotation.id.name === 'Function')))
            ) {
                // If we are a `createReactClass()` instance property then transform
                // into `((x as any) as T)`.
                if (path.parent.type === 'ObjectProperty' && isInsideCreateReactClass(path)) {
                    replaceWith(path, t.tsAsExpression(
                        t.parenthesizedExpression(t.tsAsExpression(
                            path.node.expression.expression,
                            migrateType(reporter, filePath, path.node.expression.typeAnnotation.typeAnnotation),
                        )),
                        migrateType(reporter, filePath, path.node.typeAnnotation.typeAnnotation),
                    ));
                } else {
                    replaceWith(path, t.tsAsExpression(
                        path.node.expression.expression,
                        migrateType(reporter, filePath, path.node.typeAnnotation.typeAnnotation),
                    ));
                }
            } else if (
                // `(x: any)` → `(x as any)`

                path.node.typeAnnotation.typeAnnotation.type === 'AnyTypeAnnotation'
            ) {
                replaceWith(path, t.tsAsExpression(
                    path.node.expression,
                    migrateType(reporter, filePath, path.node.typeAnnotation.typeAnnotation),
                ));
            } else if (
                // `('foo': 'foo')` → `('foo' as const)`
                // `(42: 42)` → `(42 as const)`

                (path.node.expression.type === 'StringLiteral' &&
                    path.node.typeAnnotation.typeAnnotation.type === 'StringLiteralTypeAnnotation' &&
                    path.node.expression.value === path.node.typeAnnotation.typeAnnotation.value) ||
                (path.node.expression.type === 'NumericLiteral' &&
                    path.node.typeAnnotation.typeAnnotation.type === 'NumberLiteralTypeAnnotation' &&
                    path.node.expression.value === path.node.typeAnnotation.typeAnnotation.value)
            ) {
                replaceWith(path, t.tsAsExpression(
                    path.node.expression,
                    t.tsTypeReference(t.identifier('const')),
                ));
            } else if (isComplexLiteral(path.node.expression)) {
                // `(x: T)` → `(x as T)`
                //
                // When `x` is a literal like `[]` or `null`.

                replaceWith(path, t.tsAsExpression(
                    path.node.expression,
                    migrateType(reporter, filePath, path.node.typeAnnotation.typeAnnotation),
                ));
            } else {
                // If you want to see all type casts which aren’t handled by the above:
                //
                // ```ts
                // reporter.unsupportedTypeCast(filePath, path.node.expression.loc!);
                // ```

                const safeCast = t.callExpression(
                    t.memberExpression(importUtils(path), t.identifier('cast')),
                    [path.node.expression],
                );
                safeCast.typeParameters = t.tsTypeParameterInstantiation([
                    migrateType(reporter, filePath, path.node.typeAnnotation.typeAnnotation)
                ]);
                replaceWith(path, safeCast);
            }
        },

        /* -------------------------------------------------------------------------------------- *\
        |  Patterns                                                                                |
        \* -------------------------------------------------------------------------------------- */

        AssignmentPattern(path) {
            // `function f(x?: T = y)` → `function f(x: T = y)`
            if (path.node.right && path.node.left.type === 'Identifier' && path.node.left.optional) {
                path.node.left.optional = false;
            }
        },

        /* -------------------------------------------------------------------------------------- *\
        |  JSX Detection                                                                           |
        \* -------------------------------------------------------------------------------------- */

        JSXElement() {
            fileStats.hasJsx = true;
        },
        JSXFragment() {
            fileStats.hasJsx = true;
        },
    });

    return Promise.all(awaitPromises);
}

/**
 * Adds a type annotation to all unannotated function parameters.
 */
function annotateParamsWithFlowTypeAtPos(
    reporter: MigrationReporter,
    filePath: string,
    params: t.FunctionDeclaration['params']
): Promise<unknown> {
    const awaitPromises: Array<Promise<void>> = [];

    for (const param of params) {
        if (param.type === 'Identifier' && !param.typeAnnotation) {
            awaitPromises.push((async () => {
                // Get the type Flow is inferring for this unannotated function parameter.
                const flowType = await flowTypeAtPos(filePath, param.loc!);
                if (flowType === null) return;

                // If Flow inferred `empty` then that means there were no calls to the
                // function and therefore no “lower type bounds” for the parameter. This
                // means you can do anything with the type effectively making it any. So
                // treat it as such.
                let tsType = flowType.type === 'EmptyTypeAnnotation'
                    ? t.tsAnyKeyword()
                    : migrateType(reporter, filePath, flowType);

                // Use a type alias so that developers understand why an `any`
                // was inserted.
                if (tsType.type === 'TSAnyKeyword') {
                    tsType = t.tsTypeReference(t.identifier('FlowAnyInferred'));
                }

                // Add the type annotation! Yaay.
                param.typeAnnotation = t.tsTypeAnnotation(tsType);
            })());
        }
    }

    return Promise.all(awaitPromises);
}

function tsIdentifier(
    name: string,
    optional?: boolean | null,
    typeAnnotation?: t.TSTypeAnnotation | null,
): t.Identifier {
    const identifier = t.identifier(name);
    if (optional != null) identifier.optional = optional
    if (typeAnnotation != null) identifier.typeAnnotation = typeAnnotation;
    return identifier;
}

function migrateType(
    reporter: MigrationReporter,
    filePath: string,
    flowType: t.FlowType,
): t.TSType {
    const tsType = actuallyMigrateType(reporter, filePath, flowType);
    inheritLocAndComments(flowType, tsType);
    return tsType;
}

function actuallyMigrateType(
    reporter: MigrationReporter,
    filePath: string,
    flowType: t.FlowType,
): t.TSType {
    switch (flowType.type) {
        case 'AnyTypeAnnotation':
            return t.tsAnyKeyword();

        case 'ArrayTypeAnnotation':
            return t.tsArrayType(migrateType(reporter, filePath, flowType.elementType));

        case 'BooleanTypeAnnotation':
            return t.tsBooleanKeyword();

        case 'BooleanLiteralTypeAnnotation':
            return t.tsLiteralType(t.booleanLiteral(flowType.value));

        case 'NullLiteralTypeAnnotation':
            return t.tsNullKeyword();

        case 'ExistsTypeAnnotation':
            // The existential type (`*`) in Flow is unsound and basically `any`. The Flow team even
            // deprecated existentials and plans to replace all usages at FB with `any`.
            return t.tsTypeReference(t.identifier('FlowAnyExistential'));

        case 'FunctionTypeAnnotation': {
            const typeParams = flowType.typeParameters
                ? migrateTypeParameterDeclaration(reporter, filePath, flowType.typeParameters)
                : null;
            const params = flowType.params.map<t.Identifier | t.RestElement>((flowParam, i) => {
                const tsParam = tsIdentifier(
                    // If a Flow function type argument doesn’t have a name we call it `argN`. This
                    // matches the JavaScript convention of calling function inputs “arguments”.
                    flowParam.name ? flowParam.name.name : `arg${i + 1}`,
                    flowParam.optional,
                    t.tsTypeAnnotation(migrateType(reporter, filePath, flowParam.typeAnnotation)),
                );
                inheritLocAndComments(flowParam, tsParam);
                return tsParam;
            });
            if (flowType.rest) {
                // If a Flow rest element doesn’t have a name we call it `rest`.
                const tsRestParam = t.restElement(flowType.rest.name || t.identifier('rest'));
                tsRestParam.typeAnnotation = t.tsTypeAnnotation(
                    migrateType(reporter, filePath, flowType.rest.typeAnnotation),
                );
                inheritLocAndComments(flowType.rest, tsRestParam);
                params.push(tsRestParam);

                // Technically, Flow rest parameters can be optional (`(...rest?: T[]) => void`),
                // but what does that even mean? We choose to ignore that.
            }
            return t.tsFunctionType(
                typeParams,
                params,
                t.tsTypeAnnotation(migrateType(reporter, filePath, flowType.returnType)),
            );
        }

        case 'GenericTypeAnnotation': {
            const id = migrateQualifiedIdentifier(flowType.id);
            const params = flowType.typeParameters && flowType.typeParameters.params.length > 0
                ? migrateTypeParameterInstantiation(reporter, filePath, flowType.typeParameters)
                : null;

            // `Object`  → `FlowAnyObject`
            if (id.type === 'Identifier' && id.name === 'Object' && !params) {
                return t.tsTypeReference(t.identifier('FlowAnyObject'));
            }

            // `Function` → `FlowAnyFunction`
            if (id.type === 'Identifier' && id.name === 'Function' && !params) {
                return t.tsTypeReference(t.identifier('FlowAnyFunction'));
            }

            // `$ReadOnlyArray<T>` → `ReadonlyArray<T>`
            if (
                id.type === 'Identifier' &&
                id.name === '$ReadOnlyArray' &&
                params && params.params.length === 1
            ) {
                return t.tsTypeReference(t.identifier('ReadonlyArray'), params);
            }

            // `$ReadOnly<T>` → `Readonly<T>`
            if (
                id.type === 'Identifier' &&
                id.name === '$ReadOnly' &&
                params && params.params.length === 1
            ) {
                return t.tsTypeReference(t.identifier('Readonly'), params);
            }

            // `$Keys<T>` → `keyof T`
            if (
                id.type === 'Identifier' &&
                id.name === '$Keys' &&
                params && params.params.length === 1
            ) {
                const typeOperator = t.tsTypeOperator(params.params[0]);
                typeOperator.operator = 'keyof';
                return typeOperator;
            }

            // `$Values<T>` → `h.ObjectValues<T>`
            if (
                id.type === 'Identifier' &&
                id.name === '$Values' &&
                params && params.params.length === 1
            ) {
                return t.tsTypeReference(
                    t.tsQualifiedName(t.identifier('h'), t.identifier('ObjectValues')),
                    params,
                );
            }

            // `$Shape<T>` → `Partial<T>`
            if (
                id.type === 'Identifier' &&
                id.name === '$Shape' &&
                params && params.params.length === 1
            ) {
                return t.tsTypeReference(t.identifier('Partial'), params);
            }

            // `$Subtype<T>` → `any`
            //
            // `$Subtype` and `$Supertype` are these weird utilities from Flow which have very
            // little to do with what their names are. They type check in one subtyping direction
            // but are any on the other. So `$Subtype<T> ~> U` is `T ~> U` but `U ~> $Subtype<T>` is
            // `U ~> any` (or the other way around, can’t quite remember).
            //
            // So basically these types are `any` and we will treat them as such in the migration.
            if (
                id.type === 'Identifier' &&
                id.name === '$Subtype' &&
                params && params.params.length === 1
            ) {
                return t.tsTypeReference(t.identifier('FlowAnySubtype'), params);
            }

            // `$PropertyType<T, K>` → `T[K]`
            if (
                id.type === 'Identifier' &&
                id.name === '$PropertyType' &&
                params && params.params.length === 2
            ) {
                return t.tsIndexedAccessType(params.params[0], params.params[1]);
            }

            // `$ElementType<T, K>` → `T[K]`
            if (
                id.type === 'Identifier' &&
                id.name === '$ElementType' &&
                params && params.params.length === 2
            ) {
                return t.tsIndexedAccessType(params.params[0], params.params[1]);
            }

            // `React.Node` → `React.ReactNode`
            if (
                id.type === 'TSQualifiedName' &&
                id.left.type === 'Identifier' &&
                id.left.name === 'React' &&
                id.right.type === 'Identifier' &&
                id.right.name === 'Node' &&
                !params
            ) {
                return t.tsTypeReference(
                    t.tsQualifiedName(t.identifier('React'), t.identifier('ReactNode')),
                );
            }

            // `React.Element<T>` → `React.ReactElement<React.ComponentProps<T>>`
            if (
                id.type === 'TSQualifiedName' &&
                id.left.type === 'Identifier' &&
                id.left.name === 'React' &&
                id.right.type === 'Identifier' &&
                id.right.name === 'Element' &&
                params && params.params.length === 1
            ) {
                if (
                    params.params[0].type === 'TSAnyKeyword' ||
                    (params.params[0].type === 'TSTypeReference' &&
                        (params.params[0] as any).typeName.type === 'Identifier' &&
                        (params.params[0] as any).typeName.name === 'FlowAnyExistential')
                ) {
                    return t.tsTypeReference(
                        t.tsQualifiedName(t.identifier('React'), t.identifier('ReactElement')),
                        params,
                    );
                } else {
                    return t.tsTypeReference(
                        t.tsQualifiedName(t.identifier('React'), t.identifier('ReactElement')),
                        t.tsTypeParameterInstantiation([
                            t.tsTypeReference(
                                t.tsQualifiedName(t.identifier('React'), t.identifier('ComponentProps')),
                                params,
                            ),
                        ]),
                    );
                }
            }

            return t.tsTypeReference(id, params);
        }

        case 'InterfaceTypeAnnotation':
            throw new Error(`Unsupported AST node: ${JSON.stringify(flowType.type)}`);

        case 'IntersectionTypeAnnotation':
            return t.tsIntersectionType(flowType.types.map(flowMemberType => {
                const tsMemberType = migrateType(reporter, filePath, flowMemberType);

                // Function types have weird specificities in intersections/unions. Wrap them in
                // parentheses to preserve the AST specificity.
                return tsMemberType.type === 'TSFunctionType'
                    ? t.tsParenthesizedType(tsMemberType)
                    : tsMemberType;
            }));

        case 'MixedTypeAnnotation':
            return t.tsUnknownKeyword();

        case 'EmptyTypeAnnotation':
            return t.tsNeverKeyword();

        case 'NullableTypeAnnotation': {
            return t.tsUnionType([
                migrateType(reporter, filePath, flowType.typeAnnotation),
                t.tsNullKeyword(),
                t.tsUndefinedKeyword(),
            ]);
        }

        case 'NumberLiteralTypeAnnotation':
            return t.tsLiteralType(t.numericLiteral(flowType.value));

        case 'NumberTypeAnnotation':
            return t.tsNumberKeyword();

        case 'ObjectTypeAnnotation': {
            // We ignore `exact`/`inexact` for Flow object types since that just straight up doesn’t
            // matter in TypeScript.

            // Combine all the members into one array...
            const flowMembers = [
                ...flowType.properties,
                ...(flowType.indexers || []),
                ...(flowType.callProperties || []),
                ...(flowType.internalSlots || []),
            ];

            // Sort the members by their position in source code...
            flowMembers.sort((a, b) => a.loc!.start.line - b.loc!.start.line);

            // We need to split Flow object type spreads into intersection objects.
            const intersectionTypes: Array<
                | {kind: 'literal', members: Array<t.TSTypeElement>}
                | {kind: 'reference', type: t.TSType}
            > = [];

            for (const flowMember of flowMembers) {
                if (flowMember.type === 'ObjectTypeSpreadProperty') {
                    // Recast attaches comments to the `loc`. We don’t want to miss comments
                    // attached to a spread so wrap with a parenthesized type and attach the spread
                    // loc. Prettier should remove unnesecary parentheses.
                    const tsArgument = t.tsParenthesizedType(migrateType(reporter, filePath, flowMember.argument));
                    inheritLocAndComments(flowMember, tsArgument);
                    intersectionTypes.push({kind: 'reference', type: tsArgument});
                } else {
                    // Push a migrated member into the last literal object in our intersection types
                    // array. If the last type is not an intersection, then add one.
                    let members: Array<t.TSTypeElement>;
                    const lastIntersectionType = intersectionTypes[intersectionTypes.length - 1];
                    if (lastIntersectionType && lastIntersectionType.kind === 'literal') {
                        members = lastIntersectionType.members;
                    } else {
                        members = [];
                        const nextIntersectionType = {kind: 'literal' as const, members};
                        intersectionTypes.push(nextIntersectionType);
                    }
                    members.push(migrateObjectMember(reporter, filePath, flowMember));
                }
            }

            if (intersectionTypes.length === 0) {
                return t.tsTypeLiteral([]);
            }

            const types = intersectionTypes.map(intersectionType => {
                if (intersectionType.kind === 'literal') {
                    // TypeScript only supports `string` or `number` for `T` in `{[x: T]: U}`.
                    // TypeScript also provides `Record<K, V>` as a utility type for arbitrary key
                    // types. Convert all objects of that form to `Record`.
                    if (intersectionType.members.length === 1) {
                        const onlyMember = intersectionType.members[0];
                        if (onlyMember.type === 'TSIndexSignature') {
                            const indexType = onlyMember.parameters[0].typeAnnotation! as t.TSTypeAnnotation;
                            if (
                                indexType.typeAnnotation.type !== 'TSStringKeyword' &&
                                indexType.typeAnnotation.type !== 'TSNumberKeyword'
                            ) {
                                return t.tsTypeReference(
                                    t.tsQualifiedName(t.identifier('h'), t.identifier('ObjectMap')),
                                    t.tsTypeParameterInstantiation([
                                        indexType.typeAnnotation,
                                        onlyMember.typeAnnotation!.typeAnnotation,
                                    ]),
                                );
                            }
                        }
                    }

                    return t.tsTypeLiteral(intersectionType.members);
                } else {
                    return intersectionType.type;
                }
            });

            if (types.length === 1) {
                return types[0];
            } else {
                return t.tsIntersectionType(types);
            }
        }

        case 'StringLiteralTypeAnnotation':
            return t.tsLiteralType(t.stringLiteral(flowType.value));

        case 'StringTypeAnnotation':
            return t.tsStringKeyword();

        case 'ThisTypeAnnotation':
            return t.tsThisType();

        case 'TupleTypeAnnotation': {
            return t.tsTupleType(flowType.types.map(elementType => {
                return migrateType(reporter, filePath, elementType);
            }));
        }

        case 'TypeofTypeAnnotation': {
            const tsType = migrateType(reporter, filePath, flowType.argument);

            if (tsType.type !== 'TSTypeReference')
                throw new Error(`Unexpected AST node: ${JSON.stringify(tsType.type)}`);
            if (tsType.typeParameters)
                throw new Error('Unexpected type parameters on `typeof` argument.');

            return t.tsTypeQuery(tsType.typeName);
        }

        case 'UnionTypeAnnotation': {
            let anyMemberIndex: number | null = null;

            const tsUnionType = t.tsUnionType(flowType.types.map((flowMemberType, i) => {
                const tsMemberType = migrateType(reporter, filePath, flowMemberType);

                // If one of the union members is `any` then flatten out the union to just that.
                // This happens fairly frequently for types coming from `flowTypeAtPos()`.
                if (anyMemberIndex !== null && tsMemberType.type === 'TSAnyKeyword') {
                    anyMemberIndex = i;
                }

                // Function types have weird specificities in intersections/unions. Wrap them in
                // parentheses to preserve the AST specificity.
                return tsMemberType.type === 'TSFunctionType'
                    ? t.tsParenthesizedType(tsMemberType)
                    : tsMemberType;
            }));

            return anyMemberIndex !== null ? tsUnionType.types[anyMemberIndex] : tsUnionType;
        }

        case 'VoidTypeAnnotation':
            return t.tsVoidKeyword();

        default: {
            const never: never = flowType;
            throw new Error(`Unexpected AST node: ${JSON.stringify(never['type'])}`);
        }
    }
}

function migrateQualifiedIdentifier(
    identifier: t.Identifier | t.QualifiedTypeIdentifier,
): t.Identifier | t.TSQualifiedName {
    if (identifier.type === 'Identifier') {
        return identifier;
    } else {
        const tsQualifiedName = t.tsQualifiedName(
            migrateQualifiedIdentifier(identifier.qualification),
            identifier.id,
        );
        inheritLocAndComments(identifier.qualification, tsQualifiedName);
        return tsQualifiedName;
    }
}

function migrateTypeParameterDeclaration(
    reporter: MigrationReporter,
    filePath: string,
    flowTypeParameters: t.TypeParameterDeclaration,
): t.TSTypeParameterDeclaration {
    const params = flowTypeParameters.params.map(flowTypeParameter => {
        if (flowTypeParameter.variance !== null) {
            reporter.typeParameterWithVariance(filePath, flowTypeParameter.loc!);
        }
        const tsTypeParameter = t.tsTypeParameter(
            flowTypeParameter.bound
                ? migrateType(reporter, filePath, flowTypeParameter.bound.typeAnnotation)
                : null,
            flowTypeParameter.default
                ? migrateType(reporter, filePath, flowTypeParameter.default)
                : null,
        );
        tsTypeParameter.name = flowTypeParameter.name;
        inheritLocAndComments(flowTypeParameter, tsTypeParameter);
        return tsTypeParameter;
    });
    const tsTypeParameters = t.tsTypeParameterDeclaration(params);
    inheritLocAndComments(flowTypeParameters, tsTypeParameters);
    return tsTypeParameters;
}

function migrateTypeParameterInstantiation(
    reporter: MigrationReporter,
    filePath: string,
    flowTypeParameters: t.TypeParameterInstantiation,
): t.TSTypeParameterInstantiation {
    const params = flowTypeParameters.params.map(flowTypeParameter => {
        return migrateType(reporter, filePath, flowTypeParameter);
    });
    const tsTypeParameters = t.tsTypeParameterInstantiation(params);
    inheritLocAndComments(flowTypeParameters, tsTypeParameters);
    return tsTypeParameters;
}

function migrateObjectMember(
    reporter: MigrationReporter,
    filePath: string,
    flowMember:
        | t.ObjectTypeProperty
        | t.ObjectTypeIndexer
        | t.ObjectTypeCallProperty
        | t.ObjectTypeInternalSlot,
): t.TSTypeElement {
    const tsMember = actuallyMigrateObjectMember(reporter, filePath, flowMember);
    inheritLocAndComments(flowMember, tsMember);
    return tsMember;
}

function actuallyMigrateObjectMember(
    reporter: MigrationReporter,
    filePath: string,
    flowMember:
        | t.ObjectTypeProperty
        | t.ObjectTypeIndexer
        | t.ObjectTypeCallProperty
        | t.ObjectTypeInternalSlot,
): t.TSTypeElement {
    switch (flowMember.type) {
        case 'ObjectTypeProperty': {
            if (flowMember.key.type === 'Identifier' && flowMember.key.name.startsWith('$'))
                reporter.objectPropertyWithInternalName(filePath, flowMember.loc!);
            if (flowMember.variance && flowMember.variance.kind !== 'plus')
                reporter.objectPropertyWithMinusVariance(filePath, flowMember.loc!);

            if (!(flowMember.kind || flowMember.kind === 'init'))
                throw new Error(`Unsupported object type property kind: ${JSON.stringify(flowMember.kind)}`);
            if (flowMember.proto)
                throw new Error('Did not expect any Flow properties with `proto` set to true.');
            if (flowMember.static)
                throw new Error('Did not expect any Flow properties with `static` set to true.');

            const tsValue = migrateType(reporter, filePath, flowMember.value);

            // The Babel type are wrong here...
            if (!(flowMember as any).method) {
                const tsPropertySignature = t.tsPropertySignature(
                    flowMember.key,
                    t.tsTypeAnnotation(tsValue),
                );

                tsPropertySignature.computed = flowMember.key.type !== 'Identifier';
                tsPropertySignature.optional = !!flowMember.optional;
                tsPropertySignature.readonly =
                    flowMember.variance ? flowMember.variance.kind === 'plus' : null;

                return tsPropertySignature;
            } else {
                if (tsValue.type !== 'TSFunctionType') {
                    throw new Error(`Unexpected AST node: ${JSON.stringify(tsValue.type)}`);
                }

                const tsMethodSignature = t.tsMethodSignature(
                    flowMember.key,
                    tsValue.typeParameters,
                    tsValue.parameters,
                    tsValue.typeAnnotation,
                );

                tsMethodSignature.computed = flowMember.key.type !== 'Identifier';
                tsMethodSignature.optional = !!flowMember.optional;

                return tsMethodSignature;
            }
        }

        case 'ObjectTypeIndexer': {
            if (flowMember.variance && flowMember.variance.kind !== 'plus')
                reporter.objectPropertyWithMinusVariance(filePath, flowMember.loc!);

            if (flowMember.static)
                throw new Error('Did not expect any Flow properties with `static` set to true.');

            const tsIndexSignature = t.tsIndexSignature(
                [tsIdentifier(
                    flowMember.id ? flowMember.id.name : 'key',
                    null,
                    t.tsTypeAnnotation(migrateType(reporter, filePath, flowMember.key)),
                )],
                t.tsTypeAnnotation(migrateType(reporter, filePath, flowMember.value)),
            );
            tsIndexSignature.readonly = flowMember.variance ? flowMember.variance.kind === 'plus' : null;
            return tsIndexSignature;
        }

        // Should instead use `ObjectTypeProperty` with `method` set to `true`.
        case 'ObjectTypeCallProperty':
            throw new Error(`Unsupported AST node: ${JSON.stringify(flowMember.type)}`);

        case 'ObjectTypeInternalSlot':
            throw new Error(`Unsupported AST node: ${JSON.stringify(flowMember.type)}`);

        default: {
            const never: never = flowMember;
            throw new Error(`Unrecognized AST node: ${JSON.stringify(never['type'])}`);
        }
    }
}

/**
 * Is this a literal expression? Includes literal objects and functions.
 */
function isComplexLiteral(expression: t.Expression): boolean {
    if (t.isLiteral(expression)) {
        return true;
    }
    if (expression.type === 'Identifier' && expression.name === 'undefined') {
        return true;
    }

    if (expression.type === 'ArrayExpression') {
        for (const element of expression.elements) {
            if (element === null) {
                continue;
            }
            if (element.type === 'SpreadElement') {
                if (!isComplexLiteral(element.argument)) {
                    return false;
                } else {
                    continue;
                }
            }
            if (!isComplexLiteral(element)) {
                return false;
            }
        }
        return true;
    }

    if (expression.type === 'ObjectExpression') {
        for (const property of expression.properties) {
            if (property.type === 'ObjectMethod') {
                return false;
            } else if (property.type === 'SpreadElement') {
                return false;
            } else {
                if (property.computed && !isComplexLiteral(property.key)) {
                    return false;
                }
                if (t.isExpression(property.value) && !isComplexLiteral(property.value)) {
                    return false;
                }
            }
        }
        return true;
    }

    return false;
}

/**
 * Are we inside `createReactClass()`?
 */
function isInsideCreateReactClass(path: NodePath<t.Node>): boolean {
    if (
        path.node.type === 'CallExpression' &&
        path.node.callee.type === 'Identifier' &&
        path.node.callee.name === 'createReactClass'
    ) {
        return true;
    }

    if (path.parentPath) {
        return isInsideCreateReactClass(path.parentPath);
    }

    return false;
}

/**
 * Copies the location and comments of one node to a new node.
 */
function inheritLocAndComments(oldNode: t.Node, newNode: t.Node) {
    newNode.loc = oldNode.loc;

    // Recast uses a different format for comments then Babel.
    if ((oldNode as any).comments) {
        (newNode as any).comments = (oldNode as any).comments;
        delete (oldNode as any).comments;
    }
}

/**
 * Recast uses a different format for comments. We need to manually copy them over to the new node.
 * We also attach the old location so that Recast prints it at the same place.
 *
 * https://github.com/benjamn/recast/issues/572
 */
function replaceWith(path: NodePath<t.Node>, node: t.Node) {
    inheritLocAndComments(path.node, node);
    path.replaceWith(node);
}
