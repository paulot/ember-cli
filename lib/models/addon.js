'use strict';

/**
@module ember-cli
*/

var existsSync   = require('exists-sync');
var path         = require('path');
var assign       = require('ember-cli-lodash-subset').assign;
var SilentError  = require('silent-error');
var logger       = require('heimdalljs-logger')('ember-cli:addon');

var nodeModulesPath = require('node-modules-path');

var p                   = require('ember-cli-preprocess-registry/preprocessors');
var preprocessJs        = p.preprocessJs;
var preprocessCss       = p.preprocessCss;
var preprocessTemplates = p.preprocessTemplates;

var AddonDiscovery  = require('../models/addon-discovery');
var AddonsFactory   = require('../models/addons-factory');
var CoreObject = require('core-object');
var Project = require('./project');

var mergeTrees = require('../broccoli/merge-trees');
var Funnel     = require('broccoli-funnel');
var walkSync   = require('walk-sync');
var ensurePosixPath = require('ensure-posix-path');
var defaultsDeep = require('ember-cli-lodash-subset').defaultsDeep;
var Babel = require('broccoli-babel-transpiler');
var findAddonByName = require('../utilities/find-addon-by-name');

var DEFAULT_BABEL_CONFIG = {
  modules: 'amdStrict',
  moduleIds: true,
  resolveModuleSource: require('amd-name-resolver').moduleResolve
};

function warn(message) {
  if (this.ui) {
    this.ui.writeDeprecateLine(message);
  } else {
    var chalk = require('chalk');
    console.log(chalk.yellow('DEPRECATION: '  + message));
  }
}

function deprecatedAddonFilters(addon, name, insteadUse, fn) {
  return function(tree, options) {
    var message = name + ' is deprecated, please use ' +
      insteadUse + ' directly instead  [addon: ' + addon.name + ']';

    warn(this, message);

    return fn(tree, options);
  };
}

function processModulesOnly(tree) {
  var options = defaultsDeep({}, DEFAULT_BABEL_CONFIG);
  options.whitelist = ['es6.modules'];

  return new Babel(tree, options);
}

function registryHasPreprocessor(registry, type) {
  return registry.load(type).length > 0;
}

/**
  Root class for an Addon. If your addon module exports an Object this
  will be extended from this base class. If you export a constructor (function),
  it will **not** extend from this class.

  Hooks:

  - {{#crossLink "Addon/config:method"}}{{/crossLink}}
  - {{#crossLink "Addon/blueprintsPath:method"}}{{/crossLink}}
  - {{#crossLink "Addon/includedCommands:method"}}{{/crossLink}}
  - {{#crossLink "Addon/serverMiddleware:method"}}{{/crossLink}}
  - {{#crossLink "Addon/testemMiddleware:method"}}{{/crossLink}}
  - {{#crossLink "Addon/postBuild:method"}}{{/crossLink}}
  - {{#crossLink "Addon/preBuild:method"}}{{/crossLink}}
  - {{#crossLink "Addon/outputReady:method"}}{{/crossLink}}
  - {{#crossLink "Addon/buildError:method"}}{{/crossLink}}
  - {{#crossLink "Addon/included:method"}}{{/crossLink}}
  - {{#crossLink "Addon/shouldIncludeChildAddon:method"}}{{/crossLink}}
  - {{#crossLink "Addon/setupPreprocessorRegistry:method"}}{{/crossLink}}
  - {{#crossLink "Addon/preprocessTree:method"}}{{/crossLink}}
  - {{#crossLink "Addon/postprocessTree:method"}}{{/crossLink}}
  - {{#crossLink "Addon/lintTree:method"}}{{/crossLink}}
  - {{#crossLink "Addon/contentFor:method"}}{{/crossLink}}
  - {{#crossLink "Addon/treeFor:method"}}{{/crossLink}}

  @class Addon
  @extends CoreObject
  @constructor
  @param {Project|Addon} parent The project or addon that directly depends on this addon
  @param {Project} project The current project (deprecated)
*/
var Addon = CoreObject.extend({
  init: function(parent, project) {
    this._super();
    this.parent = parent;
    this.project = project;
    this.ui = project && project.ui;
    this.addonPackages = {};
    this.addons = [];
    this.addonDiscovery = new AddonDiscovery(this.ui);
    this.addonsFactory = new AddonsFactory(this, this.project);
    this.registry = p.defaultRegistry(this);
    this._didRequiredBuildPackages = false;

    if (!this.root) {
      throw new Error('Addon classes must be instantiated with the `root` property');
    }
    this.nodeModulesPath = nodeModulesPath(this.root);

    this.treePaths = {
      app:               'app',
      styles:            'app/styles',
      templates:         'app/templates',
      addon:             'addon',
      'addon-styles':    'addon/styles',
      'addon-templates': 'addon/templates',
      vendor:            'vendor',
      'test-support':    'test-support',
      'addon-test-support': 'addon-test-support',
      public:            'public'
    };

    this.treeForMethods = {
      app:               'treeForApp',
      styles:            'treeForStyles',
      templates:         'treeForTemplates',
      'addon-templates': 'treeForAddonTemplates',
      addon:             'treeForAddon',
      vendor:            'treeForVendor',
      'test-support':    'treeForTestSupport',
      'addon-test-support': 'treeForAddonTestSupport',
      public:            'treeForPublic'
    };

    p.setupRegistry(this);

    if (!this.name) {
      throw new SilentError('An addon must define a `name` property.');
    }

    this.__originalOptions = this.options = defaultsDeep(this.options, {
      babel: DEFAULT_BABEL_CONFIG
    });

    var emberCLIBabelConfigKey = this._emberCLIBabelConfigKey();
    this.__originalOptions[emberCLIBabelConfigKey] = this.options[emberCLIBabelConfigKey] = defaultsDeep(this.options[emberCLIBabelConfigKey], {
      compileModules: true
    });
  },

  hintingEnabled: function() {
    var isProduction = process.env.EMBER_ENV === 'production';
    var testsEnabledDefault = process.env.EMBER_CLI_TEST_COMMAND || !isProduction;
    var explicitlyDisabled = this.app && this.app.options && this.app.options.hinting === false;

    return testsEnabledDefault && !explicitlyDisabled;
  },

  /**
    Loads all required modules for a build

    @private
    @method _requireBuildPackages
   */

  _requireBuildPackages: function() {
    if (this._didRequiredBuildPackages === true) {
      return;
    } else {
      this._didRequiredBuildPackages = true;
    }

    this.transpileModules = deprecatedAddonFilters(this, 'this.transpileModules', 'broccoli-es6modules', function(tree, options) {
      return new (require('broccoli-es6modules'))(tree, options);
    });

    this.pickFiles = deprecatedAddonFilters(this, 'this.pickFiles', 'broccoli-funnel', function(tree, options) {
      return new Funnel(tree, options);
    });


    this.Funnel = deprecatedAddonFilters(this, 'new this.Funnel(..)', 'broccoli-funnel', function(tree, options) {
      return new Funnel(tree, options);
    });

    this.mergeTrees = deprecatedAddonFilters(this, 'this.mergeTrees', 'broccoli-merge-trees', mergeTrees);
    this.walkSync = deprecatedAddonFilters(this, 'this.walkSync', 'node-walk-sync', walkSync);
  },

  /**
    Shorthand method for [broccoli-concat](https://github.com/ember-cli/broccoli-concat)

    @private
    @method concatFiles
    @param {tree} tree Tree of files
    @param {Object} options Options for broccoli-concat
    @return {tree} Modified tree
  */
  concatFiles: function(tree, options) {
    options.sourceMapConfig = this.app.options.sourcemaps;
    return require('broccoli-concat')(tree, options);
  },

  /**
    Allows to mark the addon as developing, triggering live-reload in the project the addon is linked to.

    #### Uses:

    - Working on projects with internal addons

    @public
    @method isDevelopingAddon
    @return {Boolean}
  */
  isDevelopingAddon: function() {
    if (process.env.EMBER_ADDON_ENV === 'development' && (this.parent instanceof Project)) {
      return this.parent.name() === this.name;
    }
    return false;
  },

  /**
    Discovers all child addons of this addon and stores their names and
    package.json contents in this.addonPackages as key-value pairs

    @private
    @method discoverAddons
   */
  discoverAddons: function() {
    var addonsList = this.addonDiscovery.discoverChildAddons(this);

    this.addonPackages = this.addonDiscovery.addonPackages(addonsList);
  },

  initializeAddons: function() {
    if (this._addonsInitialized) {
      return;
    }
    this._addonsInitialized = true;

    logger.info('initializeAddons for: %s', this.name);

    this.discoverAddons();
    this.addons = this.addonsFactory.initializeAddons(this.addonPackages);

    this.addons.forEach(function(addon) {
      logger.info('addon: %s', addon.name);
    });
  },

  /**
    Invoke the specified method for each enabled addon.

    @private
    @method eachAddonInvoke
    @param {String} methodName the method to invoke on each addon
    @param {Array} args the arguments to pass to the invoked method
  */
  eachAddonInvoke: function eachAddonInvoke(methodName, args) {
    this.initializeAddons();

    var invokeArguments = args || [];

    return this.addons.map(function(addon) {
      if (addon[methodName]) {
        return addon[methodName].apply(addon, invokeArguments);
      }
    }).filter(Boolean);
  },

  /**
    Invoke the specified method for each of the project's addons.

    @private
    @method _eachProjectAddonInvoke
    @param {String} methodName the method to invoke on each addon
    @param {Array} args the arguments to pass to the invoked method
  */
  _eachProjectAddonInvoke: function(methodName, args) {
    this.initializeAddons();

    var invokeArguments = args || [];

    return this.project.addons.map(function(addon) {
      if (addon[methodName]) {
        return addon[methodName].apply(addon, invokeArguments);
      }
    }).filter(Boolean);
  },

  /**
    Generates a tree for the specified path

    @private
    @method treeGenerator
    @return {tree}
  */
  treeGenerator: function(dir) {
    var tree;

    if (!this.project) {
      this._warn('Addon: `' + this.name + '` is missing addon.project, this may be the result of an addon forgetting to invoke `super` in its init.');
    }
    // TODO: fix law of demeter `_watchmanInfo.canNestRoots` is obviously a poor idea
    if ((this.project && this.project._watchmanInfo.canNestRoots) ||
        this.isDevelopingAddon()) {
      var WatchedDir = require('broccoli-source').WatchedDir;
      tree = new WatchedDir(dir);
    } else {
      var UnwatchedDir = require('broccoli-source').UnwatchedDir;
      tree = new UnwatchedDir(dir);
    }

    return tree;
  },

  _treePathFor: function _treePathFor(treeName) {
    var treePath = this.treePaths[treeName];
    var absoluteTreePath = path.join(this.root, treePath);
    var normalizedAbsoluteTreePath = path.normalize(absoluteTreePath);

    return ensurePosixPath(normalizedAbsoluteTreePath);
  },

  /* @private
   * @method _warn
   */
  _warn: warn,

  _emberCLIBabelConfigKey: function() {
    // future versions of ember-cli-babel will be moving the location for its
    // own configuration options out of `babel` and will be issuing a deprecation
    // if used in the older way
    //
    // see: https://github.com/babel/ember-cli-babel/pull/105
    var emberCLIBabelInstance = findAddonByName(this.addons, 'ember-cli-babel');
    var emberCLIBabelConfigKey = (emberCLIBabelInstance && emberCLIBabelInstance.configKey) || 'babel';

    return emberCLIBabelConfigKey;
  },

  /**
    Returns a given type of tree (if present), merged with the
    application tree. For each of the trees available using this
    method, you can also use a direct method called `treeFor[Type]` (eg. `treeForApp`).

    Available tree names:
    - {{#crossLink "Addon/treeForApp:method"}}app{{/crossLink}}
    - {{#crossLink "Addon/treeForStyles:method"}}styles{{/crossLink}}
    - {{#crossLink "Addon/treeForTemplates:method"}}templates{{/crossLink}}
    - {{#crossLink "Addon/treeForAddonTemplates:method"}}addon-templates{{/crossLink}}
    - {{#crossLink "Addon/treeForAddon:method"}}addon{{/crossLink}}
    - {{#crossLink "Addon/treeForVendor:method"}}vendor{{/crossLink}}
    - {{#crossLink "Addon/treeForTestSupport:method"}}test-support{{/crossLink}}
    - {{#crossLink "Addon/treeForAddonTestSupport:method"}}addon-test-support{{/crossLink}}
    - {{#crossLink "Addon/treeForPublic:method"}}public{{/crossLink}}

    #### Uses:

    - manipulating trees at build time

    @public
    @method treeFor
    @param {String} name
    @return {Tree}
  */
  treeFor: function treeFor(name) {
    this._requireBuildPackages();

    var trees = this.eachAddonInvoke('treeFor', [name]);
    var tree = this._treeFor(name);

    if (tree) {
      trees.push(tree);
    }

    if (this.isDevelopingAddon() && this.hintingEnabled() && name === 'app') {
      trees.push(this.jshintAddonTree());
    }

    return mergeTrees(trees, {
      overwrite: true,
      annotation: 'Addon#treeFor (' + this.name + ' - ' + name + ')'
    });
  },

  /**
    @private
    @param {String} name
    @method _treeFor
    @return {tree}
  */
  _treeFor: function _treeFor(name) {
    var treePath = path.resolve(this.root, this.treePaths[name]);
    var treeForMethod = this.treeForMethods[name];
    var tree;

    if (existsSync(treePath)) {
      tree = this.treeGenerator(treePath);
    }

    if (this[treeForMethod]) {
      tree = this[treeForMethod](tree);
    }

    return tree;
  },

  /**
    This method climbs up the hierarchy of addons
    up to the host application.

    This prevents previous addons (prior to `this.import`, ca 2.7.0)
    to break at importing assets when they are used nested in other addons.

    @private
    @method _findHost
  */
  _findHost: function() {
    var current = this;
    var app;

    // Keep iterating upward until we don't have a grandparent.
    // Has to do this grandparent check because at some point we hit the project.
    do {
      app = current.app || app;
    } while (current.parent.parent && (current = current.parent));

    return app;
  },

  /**
    This method is called when the addon is included in a build. You
    would typically use this hook to perform additional imports

    #### Uses:

    - including vendor files
    - setting configuration options

    *Note:* Any options set in the consuming application will override the addon.

    @public
    @method included
    @param {EmberApp|EmberAddon} parent The parent object which included this addon

    @example
    ```js
    included: function(parent) {
      this.import(somePath);
    }
    ```
  */
  included: function(/* parent */) {
    if (!this._addonsInitialized) {
      // someone called `this._super.included` without `apply` (because of older
      // core-object issues that prevent a "real" super call from working properly)
      return;
    }

    this.eachAddonInvoke('included', [this]);
  },

  /**
     Imports an asset into this addon.

     @public
     @method import
     @param {Object|String} asset Either a path to the asset or an object with environment names and paths as key-value pairs.
     @param {Object} [options] Options object
     @param {String} [options.type] Either 'vendor' or 'test', defaults to 'vendor'
     @param {Boolean} [options.prepend] Whether or not this asset should be prepended, defaults to false
     @param {String} [options.destDir] Destination directory, defaults to the name of the directory the asset is in
   */
  import: function(asset, options) {
    var app = this._findHost();
    app.import(asset, options);
  },

  /**
    Returns the tree for all app files

    @public
    @method treeForApp
    @param {Tree} tree
    @return {Tree} App file tree
  */
  treeForApp: function(tree) {
    return tree;
  },

  /**
    Returns the tree for all template files

    @public
    @method treeForTemplates
    @param {Tree} tree
    @return {Tree} Template file tree
  */
  treeForTemplates: function(tree) {
    return tree;
  },

  /**
    Returns the tree for this addon's templates

    @public
    @method treeForAddonTemplates
    @param {Tree} tree
    @return {Tree} Addon Template file tree
  */
  treeForAddonTemplates: function(tree) {
    return tree;
  },

  /**
    Returns a tree for this addon

    @public
    @method treeForAddon
    @param {Tree} tree
    @return {Tree} Addon file tree

    @example
    ```js
    treeForAddon: function() {
      var tree = this._super.treeForAddon.apply(this, arguments);
      var checker = new VersionChecker(this);
      var isOldEmber = checker.for('ember', 'bower').lt('1.13.0');

      if (isOldEmber) {
        tree = new Funnel(tree, { exclude: [ /instance-initializers/ ] });
      }

      return tree;
    }
    ```
   */
  treeForAddon: function(tree) {
    this._requireBuildPackages();

    if (!tree) {
      return tree;
    }

    var addonTree = this.compileAddon(tree);
    var stylesTree = this.compileStyles(this._treeFor('addon-styles'));

    return mergeTrees([addonTree, stylesTree], {
      annotation: 'Addon#treeForAddon(' + this.name + ')'
    });
  },

  /**
    Returns the tree for all style files

    @public
    @method treeForStyles
    @param {Tree} tree The tree to process, usually `app/styles/` in the addon.
    @return {Tree} The return tree has the same contents as the input tree, but is moved so that the `app/styles/` path is preserved.
  */
  treeForStyles: function(tree) {
    this._requireBuildPackages();

    if (!tree) {
      return tree;
    }

    return new Funnel(tree, {
      destDir: 'app/styles'
    });
  },

  /**
    Returns the tree for all vendor files

    @public
    @method treeForVendor
    @param {Tree} tree
    @return {Tree} Vendor file tree
  */
  treeForVendor: function(tree) {
    return tree;
  },

  /**
    Returns the tree for all test support files

    @public
    @method treeForTestSupport
    @param {Tree} tree
    @return {Tree} Test Support file tree
  */
  treeForTestSupport: function(tree) {
    return tree;
  },

  /**
    Returns the tree for all public files

    @public
    @method treeForPublic
    @param {Tree} tree
    @return {Tree} Public file tree
  */
  treeForPublic: function(tree) {
    this._requireBuildPackages();

    if (!tree) {
      return tree;
    }

    return new Funnel(tree, {
      srcDir: '/',
      destDir: '/' + this.moduleName()
    });
  },

  /**
   Returns the tree for all test files namespaced to a given addon.

   @public
   @method treeForAddonTestSupport
   @param {Tree} tree
   @return {Tree}
   */
  treeForAddonTestSupport: function(tree) {
    if (!tree) {
      return tree;
    }

    var processed = this.preprocessJs(tree, '/', this.name, {
      registry: this.registry
    });

    return new Funnel(processed, {
      srcDir: '/',
      destDir: '/' + this.moduleName() + '/test-support'
    });
  },

  /**
    Runs the styles tree through preprocessors.

    @private
    @method compileStyles
    @param {Tree} tree Styles file tree
    @return {Tree} Compiled styles tree
  */
  compileStyles: function(tree) {
    this._requireBuildPackages();

    if (tree) {
      return preprocessCss(tree, '/', '/', {
        outputPaths: { 'addon': this.name + '.css' },
        registry: this.registry
      });
    }
  },

  /**
    Looks in the addon/ and addon/templates trees to determine if template files
    exists that need to be precompiled.

    This is executed once when building, but not on rebuilds.

    @private
    @method shouldCompileTemplates
    @return {Boolean} indicates if templates need to be compiled for this addon
  */
  shouldCompileTemplates: function() {
    return this._fileSystemInfo().hasTemplates;
  },

  /**
     Looks in the addon/ and addon/templates trees to determine if template files
     exists in the pods format that need to be precompiled.

     This is executed once when building, but not on rebuilds.

     @private
     @method _shouldCompilePodTemplates
     @return {Boolean} indicates if pod based templates need to be compiled for this addon
  */
  _shouldCompilePodTemplates: function() {
    return this._fileSystemInfo().hasPodTemplates;
  },

  _fileSystemInfo: function() {
    if (this._cachedTemplateInfo) {
      return this._cachedTemplateInfo;
    }

    var jsExtensions = this.registry.extensionsForType('js');
    var templateExtensions = this.registry.extensionsForType('template');
    var addonTreePath = this._treePathFor('addon');
    var addonTemplatesTreePath = this._treePathFor('addon-templates');
    var addonTemplatesTreeInAddonTree = addonTemplatesTreePath.indexOf(addonTreePath) === 0;

    var files = this._getAddonTreeFiles();

    var addonTemplatesRelativeToAddonPath = addonTemplatesTreeInAddonTree && addonTemplatesTreePath.replace(addonTreePath + '/', '');
    var podTemplateMatcher = new RegExp('template\.(' + templateExtensions.join('|') + ')$');
    var hasPodTemplates = files.some(function(file) {
      // short curcuit if this is actually a `addon/templates` file
      if (addonTemplatesTreeInAddonTree && file.indexOf(addonTemplatesRelativeToAddonPath) === 0) {
        return false;
      }

      return file.match(podTemplateMatcher);
    });

    var jsMatcher = new RegExp('(' + jsExtensions.join('|') + ')$');
    var hasJSFiles = files.some(function(file) {
      return file.match(jsMatcher);
    });

    if (!addonTemplatesTreeInAddonTree) {
      files = files.concat(this._getAddonTemplatesTreeFiles());
    }

    files = files.filter(Boolean);

    var extensionMatcher = new RegExp('(' + templateExtensions.join('|') + ')$');
    var hasTemplates = files.some(function(file) {
      return file.match(extensionMatcher);
    });

    this._cachedTemplateInfo = {
      hasJSFiles: hasJSFiles,
      hasTemplates: hasTemplates,
      hasPodTemplates: hasPodTemplates
    };

    return this._cachedTemplateInfo;
  },

  _getAddonTreeFiles: function() {
    var addonTreePath = this._treePathFor('addon');

    if (existsSync(addonTreePath)) {
      return walkSync(addonTreePath);
    }

    return [];
  },

  _getAddonTemplatesTreeFiles: function() {
    var addonTemplatesTreePath = this._treePathFor('addon-templates');

    if (existsSync(addonTemplatesTreePath)) {
      return walkSync(addonTemplatesTreePath);
    }

    return [];
  },

  _addonTemplateFiles: function addonTemplateFiles(tree) {
    this._requireBuildPackages();

    if (this._cachedAddonTemplateFiles) {
      return this._cachedAddonTemplateFiles;
    }

    var trees = [];
    var addonTemplates = this._treeFor('addon-templates');
    var standardTemplates;

    if (addonTemplates) {
      standardTemplates = new Funnel(addonTemplates, {
        srcDir: '/',
        destDir: this.name + '/templates'
      });

      trees.push(standardTemplates);
    }

    if (this._shouldCompilePodTemplates()) {
      var includePatterns = this.registry.extensionsForType('template').map(function(extension) {
        return '**/*/template.' + extension;
      });

      var podTemplates = new Funnel(tree, {
        include: includePatterns,
        destDir: this.name + '/',
        annotation: 'Funnel: Addon Pod Templates'
      });

      trees.push(podTemplates);
    }

    this._cachedAddonTemplateFiles = mergeTrees(trees, {
      annotation: 'TreeMerge (' + this.name + ' templates)'
    });

    return this._cachedAddonTemplateFiles;
  },

  /**
    Runs the templates tree through preprocessors.

    @private
    @method compileTemplates
    @param {Tree} tree Templates file tree
    @return {Tree} Compiled templates tree
  */
  compileTemplates: function(tree) {
    this._requireBuildPackages();

    if (this.shouldCompileTemplates()) {
      if (!registryHasPreprocessor(this.registry, 'template')) {
        throw new SilentError('Addon templates were detected, but there ' +
                              'are no template compilers registered for `' + this.name + '`. ' +
                              'Please make sure your template precompiler (commonly `ember-cli-htmlbars`) ' +
                              'is listed in `dependencies` (NOT `devDependencies`) in ' +
                              '`' + this.name + '`\'s `package.json`.');
      }

      var processedTemplateTree = preprocessTemplates(this._addonTemplateFiles(tree), {
        annotation: 'compileTemplates(' + this.name + ')',
        registry: this.registry
      });

      return processModulesOnly(processedTemplateTree);
    }
  },

  /**
    Runs the addon tree through preprocessors.

    @private
    @method compileAddon
    @param {Tree} tree Addon file tree
    @return {Tree} Compiled addon tree
  */
  compileAddon: function(tree) {
    this._requireBuildPackages();

    if (!this.options) {
      this._warn(
        'Ember CLI addons manage their own module transpilation during the `treeForAddon` processing. ' +
          '`' + this.name + '` (found at `' + this.root + '`) has removed `this.options` ' +
          'which conflicts with the addons ability to transpile its `addon/` files properly. ' +
          'Falling back to default babel configuration options.'
      );

      this.options = {};
    }

    if (!this.options.babel) {
      this._warn(
        'Ember CLI addons manage their own module transpilation during the `treeForAddon` processing. ' +
          '`' + this.name + '` (found at `' + this.root + '`) has overridden the `this.options.babel` ' +
          'options which conflicts with the addons ability to transpile its `addon/` files properly. ' +
          'Falling back to default babel configuration options.'
      );

      this.options.babel = this.__originalOptions.babel;
    }

    var emberCLIBabelConfigKey = this._emberCLIBabelConfigKey();
    if (!this.options[emberCLIBabelConfigKey] || !this.options[emberCLIBabelConfigKey].compileModules) {
      this._warn(
        'Ember CLI addons manage their own module transpilation during the `treeForAddon` processing. ' +
          '`' + this.name + '` (found at `' + this.root + '`) has overridden the `this.options.' + emberCLIBabelConfigKey + '.compileModules` ' +
          'value which conflicts with the addons ability to transpile its `addon/` files properly.'
      );

      this.options[emberCLIBabelConfigKey] = this.options[emberCLIBabelConfigKey] || {};
      this.options[emberCLIBabelConfigKey].compileModules = true;
    }

    var addonJs = this.processedAddonJsFiles(tree);
    var templatesTree = this.compileTemplates(tree);

    var trees = [addonJs, templatesTree].filter(Boolean);

    var combinedJSAndTemplates = mergeTrees(trees, {
      overwrite: true,
      annotation: 'Addon#compileAddon(' + this.name + ') '
    });

    return new Funnel(combinedJSAndTemplates, {
      destDir: 'modules/',
      annotation: 'Funnel: compileAddon'
    });
  },

  /**
    Returns a tree with JSHhint output for all addon JS.

    @private
    @method jshintAddonTree
    @return {Tree} Tree with JShint output (tests)
  */
  jshintAddonTree: function() {
    this._requireBuildPackages();

    var addonPath = this._treePathFor('addon');

    if (!existsSync(addonPath)) {
      return;
    }

    var addonJs = this.addonJsFiles(addonPath);
    var addonTemplates = this._addonTemplateFiles(addonPath);
    var lintJsTrees = this._eachProjectAddonInvoke('lintTree', ['addon', addonJs]);
    var lintTemplateTrees = this._eachProjectAddonInvoke('lintTree', ['templates', addonTemplates]);
    var lintTrees = [].concat(lintJsTrees, lintTemplateTrees).filter(Boolean);
    var lintedAddon = mergeTrees(lintTrees, {
      overwrite: true,
      annotation: 'TreeMerger (addon-lint)'
    });

    return new Funnel(lintedAddon, {
      srcDir: '/',
      destDir: this.name + '/tests/'
    });
  },

  /**
    Returns a tree containing the addon's js files

    @private
    @method addonJsFiles
    @return {Tree} The filtered addon js files
  */
  addonJsFiles: function(tree) {
    this._requireBuildPackages();

    return new Funnel(tree, {
      destDir: this.moduleName(),
      description: 'Funnel: Addon JS'
    });
  },


  /**
    Preprocesses a javascript tree.

    @private
    @method preprocessJs
    @return {Tree} Preprocessed javascript
  */
  preprocessJs: function() {
    return preprocessJs.apply(preprocessJs, arguments);
  },

  /**
    Returns a tree with all javascript for this addon.

    @private
    @method processedAddonJsFiles
    @param {Tree} the tree to preprocess
    @return {Tree} Processed javascript file tree
  */
  processedAddonJsFiles: function(tree) {
    if (this._fileSystemInfo().hasJSFiles) {
      var processedJsFiles = this.preprocessJs(this.addonJsFiles(tree), '/', this.name, {
        registry: this.registry
      });

      if (!registryHasPreprocessor(this.registry, 'js')) {
        this._warn('Addon files were detected in `' + this._treePathFor('addon') + '`, but no JavaScript ' +
                   'preprocessors were found for `' + this.name + '`. Please make sure to add a preprocessor ' +
                   '(most likely `ember-cli-babel`) to in `dependencies` (NOT `devDependencies`) in ' +
                   '`' + this.name + '`\'s `package.json`.');

        var options = defaultsDeep({}, DEFAULT_BABEL_CONFIG);

        processedJsFiles = new Babel(processedJsFiles, options);
      }

      return processedJsFiles;
    }
  },

  /**
    Returns the module name for this addon.

    @public
    @method moduleName
    @return {String} module name
  */
  moduleName: function() {
    if (!this.modulePrefix) {
      this.modulePrefix = (this.modulePrefix || this.name).toLowerCase().replace(/\s/g, '-');
    }

    return this.modulePrefix;
  },

  /**
    Returns the path for addon blueprints.

    @public
    @method blueprintsPath
    @return {String} The path for blueprints

    @example
    - [ember-cli-coffeescript](https://github.com/kimroen/ember-cli-coffeescript/blob/v1.13.2/index.js#L26)
  */
  blueprintsPath: function() {
    var blueprintPath = path.join(this.root, 'blueprints');

    if (existsSync(blueprintPath)) {
      return blueprintPath;
    }
  },

  /**
    Augments the applications configuration settings.

    Object returned from this hook is merged with the application's configuration object.

    Application's configuration always take precedence.

    #### Uses:

    - Modifying configuration options (see list of defaults [here](https://github.com/ember-cli/ember-cli/blob/v2.4.3/lib/broccoli/ember-app.js#L163))
      - For example
        - `minifyJS`
        - `storeConfigInMeta`
        - et, al

    @public
    @method config
    @param {String} env Name of current environment (ie "developement")
    @param {Object} baseConfig Initial application configuration
    @return {Object} Configuration object to be merged with application configuration.

    @example
    ```js
    config: function(environment, appConfig) {
      return {
        someAddonDefault: "foo"
      };
    }
    ```
  */
  config: function (env, baseConfig) {
    var configPath = path.join(this.root, 'config', 'environment.js');

    if (existsSync(configPath)) {
      var configGenerator = require(configPath);

      return configGenerator(env, baseConfig);
    }
  },

  /**
    @public
    @method dependencies
    @return {Object} The addon's dependencies based on the addon's package.json
  */
  dependencies: function() {
    var pkg = this.pkg || {};
    return assign({}, pkg['devDependencies'], pkg['dependencies']);
  },

  /**
    @public
    @method isEnabled
    @return {Boolean} Whether or not this addon is enabled
  */
  isEnabled: function() {
    return true;
  },

  /**
    Can be used to exclude addons from being added as a child addon.

    #### Uses:

    - Abstract away multiple addons while only including one into the built assets

    @public
    @method shouldIncludeChildAddon
    @param {Addon} childAddon
    @return {Boolean} Whether or not a child addon is supposed to be included

    @example
    ```js
    shouldIncludeChildAddon: function(childAddon) {
      if(childAddon.name === 'ember-cli-some-legacy-select-component') {
        return this.options.legacyMode;
      } else if(childAddon.name === 'ember-cli-awesome-new-select-component') {
        return !this.options.legacyMode;
      } else {
        return this._super.shouldIncludeChildAddon.apply(this, arguments);
      }
    }
    ```
  */
  shouldIncludeChildAddon: function() {
    return true;
  }
});

/**
  Returns the absolute path for a given addon

  @private
  @method resolvePath
  @param {String} addon Addon name
  @return {String} Absolute addon path
*/
Addon.resolvePath = function(addon) {
  var addonMain = addon.pkg['ember-addon-main'];

  if (addonMain) {
    this.ui && this.ui.writeDeprecateLine(addon.pkg.name + ' is using the deprecated ember-addon-main definition. It should be updated to {\'ember-addon\': {\'main\': \'' + addon.pkg['ember-addon-main'] + '\'}}');
  } else {
    addonMain = (addon.pkg['ember-addon'] && addon.pkg['ember-addon'].main) || addon.pkg['main'] || 'index.js';
  }

  // Resolve will fail unless it has an extension
  if (!path.extname(addonMain)) {
    addonMain += '.js';
  }

  return path.resolve(addon.path, addonMain);
};

/**
  Returns the addon class for a given addon name.
  If the Addon exports a function, that function is used
  as constructor. If an Object is exported, a subclass of
  `Addon` is returned with the exported hash merged into it.

  @private
  @static
  @method lookup
  @param {String} addon Addon name
  @return {Addon} Addon class
*/
Addon.lookup = function(addon) {
  var Constructor, addonModule, modulePath, moduleDir;
  var start = Date.now();

  modulePath = Addon.resolvePath(addon);
  moduleDir  = path.dirname(modulePath);

  if (existsSync(modulePath)) {
    addonModule = require(modulePath);

    if (typeof addonModule === 'function') {
      Constructor = addonModule;
      Constructor.prototype.root = Constructor.prototype.root || moduleDir;
      Constructor.prototype.pkg  = Constructor.prototype.pkg || addon.pkg;
    } else {
      Constructor = Addon.extend(assign({
        root: moduleDir,
        pkg: addon.pkg
      }, addonModule));
    }
  }

  if (!Constructor) {
    throw new SilentError('The `' + addon.pkg.name + '` addon could not be found at `' + addon.path + '`.');
  }

  var lookupDuration = Date.now() - start;

  Constructor._meta_ = {
    modulePath: modulePath,
    lookupDuration: lookupDuration,
    initializeIn: 0
  };

  return Constructor;
};


// Methods without default implementation

/**
  Allows the specification of custom addon commands.
  Expects you to return an object whose key is the name of the command and value is the command instance..

  This function is not implemented by default

  #### Uses:

  - Include custom commands into consuming application

  @public
  @method includedCommands
  @return {Object} An object with included commands

  @example
  ```js
  includedCommands: function() {
    return {
      'do-foo': require('./lib/commands/foo')
    };
  }
  ```
*/


/**
  Pre-process a tree

  #### Uses:

  - removing / adding files from the build.

  @public
  @method preprocessTree
  @param {String} type What kind of tree (eg. 'javascript', 'styles')
  @param {Tree} tree Tree to process
  @return {Tree} Processed tree
 */


/**
  Post-process a tree

  @public
  @method postprocessTree
  @param {String} type What kind of tree (eg. 'javascript', 'styles')
  @param {Tree} tree Tree to process
  @return {Tree} Processed tree

  @example
  - [broccoli-asset-rev](https://github.com/rickharrison/broccoli-asset-rev/blob/c82c3580855554a31f7d6600b866aecf69cdaa6d/index.js#L29)
 */


/**
  This hook allows you to make changes to the express server run by ember-cli.

  It's passed a `startOptions` object which contains:
  - `app` Express server instance
  - `options` A hash with:
    - `project` Current {{#crossLink "Project"}}project{{/crossLink}}
    - `watcher`
    - `environment`

  This function is not implemented by default

  #### Uses:

  - Tacking on headers to each request
  - Modifying the request object

  *Note:* that this should only be used in development, and if you need the same behavior in production you'll
  need to configure your server.

  @public
  @method serverMiddleware
  @param {Object} startOptions Express server start options

  @example
  ```js
  serverMiddleware: function(startOptions) {
    var app = startOptions.app;

    app.use(function(req, res, next) {
      // Some middleware
    });
  }
  ```

  - [ember-cli-content-security-policy](https://github.com/rwjblue/ember-cli-content-security-policy/blob/v0.5.0/index.js#L84)
  - [history-support-addon](https://github.com/ember-cli/ember-cli/blob/v2.4.3/lib/tasks/server/middleware/history-support/index.js#L25)
 */


/**
 This hook allows you to make changes to the express server run by testem.

 This function is not implemented by default

 #### Uses:

 - Adding custom test-specific endpoints
 - Manipulating HTTP requests in tests

 @public
 @method testemMiddleware
 @param {Object} app the express app instance
 */


/**
  This hook is called before a build takes place.

  @public
  @method preBuild
  @param {Object} result Build object
*/


/**
  This hook is called after a build is complete.

  It's passed a `result` object which contains:
  - `directory` Path to build output

  #### Uses:

  - Slow tree listing
  - May be used to manipulate your project after build has happened

  @public
  @method postBuild
  @param {Object} result Build result object
*/


/**
  This hook is called after the build has been processed and the build files have been copied to the output directory

  It's passed a `result` object which contains:
  - `directory` Path to build output

  @public
  @method outputReady
  @param {Object} result Build result object

  @example
  - Opportunity to symlink or copy files elsewhere.
  - [ember-cli-rails-addon](https://github.com/rondale-sc/ember-cli-rails-addon/blob/v0.7.0/index.js#L45)
    - In this case we are using this in tandem with a rails middleware to remove a lock file.
      This allows our ruby gem to block incoming requests until after the build happens reliably.
 */


/**
  This hook is called when an error occurs during the preBuild, postBuild or outputReady hooks
  for addons, or when the build fails

  #### Uses:

  - Custom error handling during build process

  @public
  @method buildError
  @param {Error} error The error that was caught during the processes listed above

  @example
  - [ember-cli-rails-addon](https://github.com/rondale-sc/ember-cli-rails-addon/blob/v0.7.0/index.js#L11)
*/


/**
 Used to add preprocessors to the preprocessor registry. This is often used by addons like [ember-cli-htmlbars](https://github.com/ember-cli/ember-cli-htmlbars)
 and [ember-cli-coffeescript](https://github.com/kimroen/ember-cli-coffeescript) to add a `template` or `js` preprocessor to the registry.

 **Uses:**

 - Adding preprocessors to the registry.

 @public
 @method setupPreprocessorRegistry
 @param {String} type either `"self"` or `"parent"`
 @param registry the registry to be set up

 @example
 ```js
 setupPreprocessorRegistry: function(type, registry) {
   // ensure that broccoli-ember-hbs-template-compiler is not processing hbs files
   registry.remove('template', 'broccoli-ember-hbs-template-compiler');

   registry.add('template', {
     name: 'ember-cli-htmlbars',
     ext: 'hbs',
     _addon: this,
     toTree: function(tree) {
       var htmlbarsOptions = this._addon.htmlbarsOptions();
       return htmlbarsCompile(tree, htmlbarsOptions);
     },

     precompile: function(string) {
       var htmlbarsOptions = this._addon.htmlbarsOptions();
       var templateCompiler = htmlbarsOptions.templateCompiler;
       return utils.template(templateCompiler, string);
     }
   });

   if (type === 'parent') {
     this.parentRegistry = registry;
   }
 }
 ```
*/


/**
 Return value is merged into the **tests** tree. This lets you inject
 linter output as test results.

 **Uses:**

 - JSHint
 - any other form of automated test generation that turns code into tests

 @public
 @method lintTree
 @param {String} treeType `app`, `tests`, `templates`, or `addon`
 @param {Tree} tree tree of files (JavaScript files for `app`, `tests`, and `addon` types)

 @example
 - [ember-cli-qunit](https://github.com/ember-cli/ember-cli-qunit/blob/v1.4.1/index.js#L206)
 - [ember-cli-mocha](https://github.com/ef4/ember-cli-mocha/blob/66803037fe203b24e96dea83a2bd91de48b842e1/index.js#L101)
*/


/**
 Allow addons to implement contentFor method to add string output into the associated `{{content-for 'foo'}}` section in `index.html`

 **Uses:**

 - For instance, to inject analytics code into `index.html`

 @public
 @method contentFor
 @param type
 @param config
 @param content

 @example
 - [ember-cli-google-analytics](https://github.com/pgrippi/ember-cli-google-analytics/blob/v1.5.0/index.js#L79)
*/

module.exports = Addon;
