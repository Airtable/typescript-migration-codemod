/**
 * These are locations of `require` that are not `require` calls which have been manually verified
 * to be safe for our ES Module migration.
 */
export const requireNotCalled = new Set<string>([
    // NOTE(calebmer): Removed hardcoded Airtable codebase paths when open sourcing.
    //
    // Files which use the `require` identifier without calling it. Locations were added to this
    // list as relative path plus line/column numbers: `path/to/some/file.js:14:5`.
    //
    // Reasons we added exceptions include:
    //
    // - Testing that current module is the main with `require.main === module`.
    // - `require.ensure` with no dependencies.
    // - Invalidation using `require.cache`.
    // - Object property like `{ require: x }`.
    // - Testing `require` availability.
    // - Yargs configuration.
]);

/**
 * These are locations of `require(dynamicModuleId)` which have been manually verified to be safe
 * for our ES Module migration.
 */
export const requireOtherThanString = new Set<string>([
    // NOTE(calebmer): Removed hardcoded Airtable codebase paths when open sourcing.
]);

/**
 * These are locations of modules which could not be found by `require.resolve()` which have been
 * manually verified to be safe for our ES Module migration.
 */
export const cannotFindModule = new Set<string>([
    // NOTE(calebmer): Removed hardcoded Airtable codebase paths when open sourcing.
]);

/**
 * These are locations of the `module` identifier when it is not in `module.exports` which have been
 * manually verified to be safe for our ES Module migration.
 */
export const moduleNotExportAssignment = new Set<string>([
    // NOTE(calebmer): Removed hardcoded Airtable codebase paths when open sourcing.
    //
    // Files which use the `module` identifier but not in the form `module.exports = x`. Locations
    // were added to this list as relative path plus line/column numbers:
    // `path/to/some/file.js:14:5`.
    //
    // Reasons we added exceptions include:
    //
    // - Testing that current module is the main with `require.main === module`.
    // - CommonJS environment testing in vendored third-party code.
]);

export type ModuleWithNamedExports = {
    defaultImport: 'none' | 'defaultExport' | 'namespaceImport',
    exports: Set<string>,
};

/**
 * The modules which we special case to have named exports. All other modules will have a
 * default export.
 */
export const modulesWithNamedExports = new Map<string, ModuleWithNamedExports>([
    // NOTE(calebmer): Removed hardcoded Airtable codebase paths when open sourcing.
    //
    // We transformed all module `module.exports = x` to `export default x` except for a couple
    // common modules. Those modules were added to this list.
]);

/**
 * Overrides for the `isBabelInteropDefaultImportTheSame()` function. Will be true if a Babel import
 * default is the same as a CommonJS require.
 *
 * We need an override for these modules because they throw when we try to require them in a
 * worker module.
 */
export const babelInteropDefaultImportOverrides = new Map<string, boolean>([
    // NOTE(calebmer): Removed hardcoded Airtable codebase paths when open sourcing.
    //
    // We `require()` every third-party module in the codemod to test how it would work in an ES
    // Module environment. Some modules (understandably) throw when you try to import them in a
    // Node.js environment. For modules that throw we provided an override here.
]);
