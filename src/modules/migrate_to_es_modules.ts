import {dirname, basename, extname} from 'path';
import camelCase from 'camelcase';
import * as t from '@babel/types';
import traverse, {NodePath} from '@babel/traverse';
import MigrationReporter from './migration_reporter';
import shouldMigrateFilePath from './should_migrate_file_path';
import * as allowlists from './allowlists';
import isBabelInteropDefaultImportTheSame from './babel_interop_default_import';

export default function migrateToEsModules(
    reporter: MigrationReporter,
    filePath: string,
    file: t.File,
) {
    traverse(file, {
        Program: {
            exit(path) {
                // Check to see if any side-effects will be broken by hoisted ES Modules.
                if (shouldMigrateFilePath(filePath)) {
                    doesProgramHaveSideEffectsBeforeImports({
                        reporter,
                        filePath,
                        program: path.node,
                    });
                }
            },
        },
        DirectiveLiteral(path) {
            // ES Modules are implicitly in strict mode so we don’t need the directive anymore.
            if (shouldMigrateFilePath(filePath)) {
                if (path.node.value === 'use strict') {
                    path.parentPath.remove();
                }
            }
        },
        Identifier(path) {
            // Don’t visit the same node twice. Fixes an infinite recursion error.
            if ((path.node as any)[visited]) return;
            (path.node as any)[visited] = true;

            // Handle any reference to the Node.js `require` identifier:
            if (path.node.name === 'require') {
                if (path.parent.type !== 'CallExpression') {
                    reporter.requireNotCalled(filePath, path.node.loc!);
                } else {
                    if (path.parent.arguments.length !== 1) {
                        throw new Error(`Expected require() calls to only have one argument.`);
                    }
                    const moduleId = path.parent.arguments[0];
                    if (moduleId.type !== 'StringLiteral') {
                        reporter.requireOtherThanString(filePath, moduleId.loc!);
                    } else {
                        // Resolve the full path to a module using the Node.js
                        // resolution algorithm.
                        let modulePath;
                        try {
                            modulePath = require.resolve(
                                moduleId.value,
                                {paths: [dirname(filePath)]},
                            );
                        } catch (error) {
                            reporter.cannotFindModule(moduleId.value, filePath, moduleId.loc!);
                            modulePath = null;
                        }

                        // If we were able to resolve the module path...
                        if (modulePath !== null) {
                            const callPath = path.parentPath;
                            if (callPath.node.type !== 'CallExpression') {
                                throw new Error('Expected above conditions to prove this is a call expression.');
                            }

                            if (shouldMigrateFilePath(filePath)) {
                                migrateRequireToImport({
                                    reporter,
                                    path,
                                    callPath: callPath as NodePath<t.CallExpression>,
                                    moduleId,
                                    modulePath,
                                });
                            } else {
                                // Modules with custom handling should not be used outside of
                                // migrated modules.
                                if (allowlists.modulesWithNamedExports.has(moduleId.value)) {
                                    throw new Error(
                                        'Did not expect a named exports module to be used in a ' +
                                            'file that is not migrated.'
                                    );
                                }

                                // If we are not a module which will be transpiled by Babel, but we
                                // are importing a transpiled module then we need to add `.default`
                                // to the require.
                                if (shouldMigrateFilePath(modulePath)) {
                                    replaceWith(callPath, t.memberExpression(
                                        callPath.node,
                                        t.identifier('default'),
                                    ));
                                }
                            }
                        }
                    }
                }
            }

            // Handle any reference to the Node.js `module` identifier:
            if (path.node.name === 'module') {
                const {node, parent} = path;

                if (
                    // If someone has locally declared a module variable, that’s fine.
                    path.scope.hasBinding('module') ||

                    // Object property access is fine.
                    (parent.type === 'ObjectProperty' && parent.key === node) ||
                    (parent.type === 'MemberExpression' && parent.computed === false && parent.property === node) ||
                    (parent.type === 'ObjectTypeProperty' && parent.key === node)
                ) {
                    // Use of `module` that is not dangerous to our migration script. We can
                    // ignore it.
                } else if (!(
                    isModuleExports(parent) &&
                    path.parentPath.parent.type === 'AssignmentExpression' &&
                    path.parentPath.parent.left === parent &&
                    path.parentPath.parentPath.parent.type === 'ExpressionStatement' &&
                    path.parentPath.parentPath.parentPath.parent.type === 'Program'
                )) {
                    reporter.moduleNotExportAssignment(filePath, node.loc!);
                } else {
                    if (shouldMigrateFilePath(filePath)) {
                        const assignmentPath = path // `Identifier`
                            .parentPath // `MemberExpression`
                            .parentPath; // `AssignmentExpression`

                        if (assignmentPath.node.type !== 'AssignmentExpression') {
                            throw new Error(`Expected above conditions to prove this is an assignment expression.`);
                        }

                        const statementPath = assignmentPath // `AssignmentExpresison`
                            .parentPath; // `ExpressionStatement`

                        // Workaround a bug in Recast that drops parentheses around type
                        // cast expressions by rebuilding the AST node.
                        let exportExpression = assignmentPath.node.right;
                        if (exportExpression.type === 'TypeCastExpression') {
                            exportExpression = t.typeCastExpression(
                                exportExpression.expression,
                                exportExpression.typeAnnotation,
                            );
                        }

                        // Actually replace `module.exports` with `export default`!
                        replaceWith(
                            statementPath,
                            t.exportDefaultDeclaration(exportExpression),
                        );
                    }
                }
            }

            // Handle any reference to the Node.js `exports` identifier:
            if (path.node.name === 'exports') {
                const {node, parent} = path;

                if (!isModuleExports(parent)) {
                    reporter.moduleNotExportAssignment(filePath, node.loc!);
                }
            }
        },
    });
}

const visited = Symbol('visited');

function isModuleExports(node: t.Node): boolean {
    return (
        node.type === 'MemberExpression' && node.computed === false &&
        node.object.type === 'Identifier' && node.object.name === 'module' &&
        node.property.type === 'Identifier' && node.property.name === 'exports'
    );
}

function migrateRequireToImport({
    reporter,
    path,
    callPath,
    moduleId,
    modulePath,
}: {
    path: NodePath<t.Identifier>,
    reporter: MigrationReporter,
    callPath: NodePath<t.CallExpression>,
    moduleId: t.StringLiteral,
    modulePath: string,
}) {
    // Determine if we should use a default or namespace import. We always use a default import for
    // migrated files. We load the module in our worker process to determine whether we should use
    // a default or namespace import.
    let defaultImport: boolean;
    if (shouldMigrateFilePath(modulePath)) {
        defaultImport = true;
    } else {
        const sameBabelInteropDefaultImport = isBabelInteropDefaultImportTheSame(modulePath);

        // If we were not able to load this module then don’t migrate this require!
        if (sameBabelInteropDefaultImport === null) {
            reporter.unableToLoadExternalModule(modulePath);
            return;
        }
        defaultImport = sameBabelInteropDefaultImport;
    }

    const moduleWithNamedExport = allowlists.modulesWithNamedExports.get(moduleId.value);

    // A common pattern is `const foo = require('bar').foo`. To make this pattern work better with
    // our migration tooling we convert it to `const {foo} = require('bar')` before processing
    // the require.
    if (
        callPath.parent.type === 'MemberExpression' &&
        callPath.parent.computed === false &&
        callPath.parentPath.parent.type === 'VariableDeclarator' &&
        callPath.parentPath.parent.id.type === 'Identifier'
    ) {
        const key = callPath.parent.property;
        const value = callPath.parentPath.parent.id;
        replaceWith(callPath.parentPath.parentPath, t.variableDeclarator(
            t.objectPattern([t.objectProperty(key, value, false, key.name === value.name)]),
            callPath.node,
        ));
        // Make sure to re-visit this node now that we’ve transformed it!
        (callPath.node.callee as any)[visited] = false;
        return;
    }

    // If we are in a file which should be migrated, and we have a top level require then change it
    // to an import declaration.
    if (
        callPath.parent.type === 'VariableDeclarator' &&
        callPath.parentPath.parent.type === 'VariableDeclaration' &&
        callPath.parentPath.parentPath.parent.type === 'Program'
    ) {
        if (callPath.parentPath.parent.declarations.length !== 1) {
            throw new Error('Expected there to only be one variable declarator.');
        }

        const importPattern = callPath.parent.id;

        if (moduleWithNamedExport === undefined) {
            // If we are importing to an identifier we can replace the require with an
            // import statement.
            //
            // Otherwise we create a temporary variable that we destructure.
            if (importPattern.type === 'Identifier' && !importPattern.typeAnnotation) {
                replaceWith(callPath.parentPath.parentPath, t.importDeclaration(
                    [defaultImport
                        ? t.importDefaultSpecifier(importPattern)
                        : t.importNamespaceSpecifier(importPattern)],
                    moduleId,
                ));
            } else if (importPattern.type === 'ObjectPattern' && defaultImport === false) {
                // If this is not a default import module and we have an object destructure then
                // trust that each key is a valid named import!

                const importSpecifiers = importPattern.properties.map(property => {
                    if (property.type !== 'ObjectProperty')
                        throw new Error(`Unexpected AST node: '${property.type}'`);
                    if (property.computed !== false)
                        throw new Error(`Expected object property key to not be computed.`);
                    if (property.value.type !== 'Identifier')
                        throw new Error(`Unexpected AST node: '${property.value.type}'`);

                    if (property.key.name === 'default') {
                        return t.importDefaultSpecifier(property.value);
                    } else {
                        return t.importSpecifier(property.value, property.key);
                    }
                });

                replaceWith(callPath.parentPath.parentPath, t.importDeclaration(
                    importSpecifiers,
                    moduleId,
                ));
            } else {
                reporter.requireWasDestructed(modulePath);

                // If we are destructuring the import then we need to add a level of indirection.
                const moduleName = camelCase(basename(moduleId.value, extname(moduleId.value)));
                const tmpIdentifier = path.scope.generateUidIdentifier(moduleName);

                const destructVariableDeclaration = t.variableDeclaration('const', [
                    t.variableDeclarator(importPattern, tmpIdentifier),
                ]);

                // Special flag for our Recast fork...
                (destructVariableDeclaration as any).recastDisableMultilineSpacing = true;

                replaceWithMultipleCopyingComments(callPath.parentPath.parentPath, [
                    t.importDeclaration(
                        [defaultImport
                            ? t.importDefaultSpecifier(tmpIdentifier)
                            : t.importNamespaceSpecifier(tmpIdentifier)],
                        moduleId,
                    ),
                    destructVariableDeclaration,
                ]);
            }
        } else {
            if (importPattern.type === 'Identifier') {
                // Default imports for a module we give named exports has various
                // special behaviors...
                switch (moduleWithNamedExport.defaultImport) {
                    case 'defaultExport': {
                        replaceWith(callPath.parentPath.parentPath, t.importDeclaration(
                            [t.importDefaultSpecifier(importPattern)],
                            moduleId,
                        ));
                        break;
                    }
                    case 'namespaceImport': {
                        replaceWith(callPath.parentPath.parentPath, t.importDeclaration(
                            [t.importNamespaceSpecifier(importPattern)],
                            moduleId,
                        ));
                        break;
                    }
                    case 'none':
                        throw new Error(`Did not expect '${moduleId.value}' to have a default import.`);
                    default: {
                        const never: never = moduleWithNamedExport.defaultImport;
                        throw new Error(`Unexpected: '${never}'`);
                    }
                }
            } else if (importPattern.type === 'ObjectPattern') {
                // Transform a simple object destructuring into a named import.
                const importSpecifiers = importPattern.properties.map(property => {
                    if (property.type !== 'ObjectProperty')
                        throw new Error(`Unexpected AST node: '${property.type}'`);
                    if (property.computed !== false)
                        throw new Error(`Expected object property key to not be computed.`);
                    if (property.value.type !== 'Identifier')
                        throw new Error(`Unexpected AST node: '${property.value.type}'`);
                    if (!moduleWithNamedExport.exports.has(property.key.name))
                        throw new Error(`Unexpected import '${property.key.name}' from '${moduleId.value}'`);

                    return t.importSpecifier(property.value, property.key);
                });

                replaceWith(callPath.parentPath.parentPath, t.importDeclaration(
                    importSpecifiers,
                    moduleId,
                ));
            } else {
                throw new Error(`Unexpected AST node: '${importPattern.type}'`);
            }
        }
    } else if (
        callPath.parent.type === 'ExpressionStatement' &&
        callPath.parentPath.parent.type === 'Program'
    ) {
        // Imports only for side effects are also converted into import declarations.
        replaceWith(callPath.parentPath, t.importDeclaration([], moduleId));
    } else {
        if (moduleWithNamedExport === undefined) {
            // If we are not requiring at the top level, but we are importing a transpiled module then
            // we need to add `.default` to the require.
            //
            // TODO: Report these for manual fixes!
            if (shouldMigrateFilePath(modulePath)) {
                replaceWith<t.Expression>(callPath, t.memberExpression(
                    callPath.node,
                    t.identifier('default'),
                ));
            }
        } else {
            switch (moduleWithNamedExport.defaultImport) {
                case 'defaultExport': {
                    // They still have a default export...
                    replaceWith<t.Expression>(callPath, t.memberExpression(
                        callPath.node,
                        t.identifier('default'),
                    ));
                    break;
                }
                case 'namespaceImport': {
                    // We can leave these alone...
                    break;
                }
                case 'none':
                    throw new Error(`Did not expect '${moduleId.value}' to have a default import.`);
                default: {
                    const never: never = moduleWithNamedExport.defaultImport;
                    throw new Error(`Unexpected: '${never}'`);
                }
            }
        }
    }
}

/**
 * Checks to see if the program does some side effects before imports that the imported module might
 * depend on. Babel hoists imports to the top so these side effects will break.
 */
function doesProgramHaveSideEffectsBeforeImports({
    reporter,
    filePath,
    program,
}: {
    reporter: MigrationReporter,
    filePath: string,
    program: t.Program,
}) {
    let importZone = true;

    for (const statement of program.body) {
        if (
            statement.type === 'ImportDeclaration' &&
            (!statement.importKind || statement.importKind === 'value')
        ) {
            if (importZone === false && statement.loc) {
                reporter.importAfterSideEffects(filePath, statement.loc);
                break;
            }
        }
        if (statementHasSideEffects(statement)) {
            importZone = false;
        }
    }
}

/**
 * Conservative check for whether a statement has any side-effects that should be executed before
 * an import.
 */
function statementHasSideEffects(statement: t.Statement): boolean {
    if (statement.type === 'ImportDeclaration') {
        return false;
    }
    if (statement.type === 'ExpressionStatement') {
        return expressionHasSideEffects(statement.expression);
    }
    if (statement.type === 'VariableDeclaration') {
        for (const declarator of statement.declarations) {
            if (declarator.init && expressionHasSideEffects(declarator.init)) {
                return true;
            }
        }
        return false;
    }
    return true;
}

/**
 * Conservative check for whether an expression has any side-effects that should be executed before
 * an import.
 */
function expressionHasSideEffects(expression: t.Expression): boolean {
    if (t.isLiteral(expression)) {
        return false;
    }
    if (expression.type === 'Identifier') {
        return false;
    }
    if (expression.type === 'MemberExpression') {
        // Technically a getter could have a side-effect, but it’s pretty uncommon that we’d have
        // a getter with a signfificant side-effect.
        return (
            expressionHasSideEffects(expression.object) ||
            expressionHasSideEffects(expression.property)
        );
    }
    return true;
}

/**
 * Recast uses a different format for comments. We need to manually copy them over to the new node.
 * We also attach the old location so that Recast prints it at the same place.
 *
 * https://github.com/benjamn/recast/issues/572
 */
function replaceWith<T extends t.Node>(path: NodePath<T>, node: T) {
    node.loc = path.node.loc;

    if ((path.node as any).comments) {
        (node as any).comments = (path.node as any).comments;
        delete (path.node as any).comments;
    }

    path.replaceWith(node);
}

/**
 * Recast uses a different format for comments. We need to manually copy them over to the new node.
 * We also attach the old location so that Recast prints it at the same place.
 *
 * https://github.com/benjamn/recast/issues/572
 */
function replaceWithMultipleCopyingComments<T extends t.Node>(path: NodePath<T>, nodes: Array<T>) {
    if (nodes.length === 0) throw new Error('Unsupported');

    if ((path.node as any).comments) {
        (nodes as any)[0].comments = (path.node as any).comments;
        delete (path.node as any).comments;
    }

    path.replaceWithMultiple(nodes);
}
