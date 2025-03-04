const { TemplatePath } = require("@11ty/eleventy-utils");
const { performance } = require("perf_hooks");

const pkg = require("../package.json");
const TemplateData = require("./TemplateData");
const TemplateWriter = require("./TemplateWriter");
const EleventyExtensionMap = require("./EleventyExtensionMap");
const EleventyErrorHandler = require("./EleventyErrorHandler");
const EleventyBaseError = require("./EleventyBaseError");
const EleventyServe = require("./EleventyServe");
const EleventyWatch = require("./EleventyWatch");
const EleventyWatchTargets = require("./EleventyWatchTargets");
const EleventyFiles = require("./EleventyFiles");
const ConsoleLogger = require("./Util/ConsoleLogger");
const PathPrefixer = require("./Util/PathPrefixer");
const TemplateConfig = require("./TemplateConfig");
const FileSystemSearch = require("./FileSystemSearch");

const simplePlural = require("./Util/Pluralize");
const checkPassthroughCopyBehavior = require("./Util/PassthroughCopyBehaviorCheck");
const debug = require("debug")("Eleventy");
const eventBus = require("./EventBus");

/**
 * @module 11ty/eleventy/Eleventy
 */

/**
 * Runtime of eleventy.
 *
 * @param {String} input - Where to read files from.
 * @param {String} output - Where to write rendered files to.
 * @returns {module:11ty/eleventy/Eleventy~Eleventy}
 */
class Eleventy {
  constructor(input, output, options = {}, eleventyConfig = null) {
    if (!eleventyConfig) {
      this.eleventyConfig = new TemplateConfig(null, options.configPath);
    } else {
      this.eleventyConfig = eleventyConfig;
      if (options.configPath) {
        this.eleventyConfig.setProjectConfigPath(options.configPath);
      }
    }

    this.eleventyConfig.setLogger(this.logger);

    /**
     * @member {String} - The top level directory the site pretends to reside in
     * @default "/"
     */
    this.pathPrefix = options.pathPrefix || "/";

    if (this.pathPrefix || this.pathPrefix === "") {
      this.eleventyConfig.setPathPrefix(this.pathPrefix);
    }

    /* Programmatic API config */
    if (options.config && typeof options.config === "function") {
      // TODO use return object here?
      options.config(this.eleventyConfig.userConfig);
    }

    /**
     * @member {String} - The path to Eleventy's config file.
     * @default null
     */
    this.configPath = options.configPath;

    /**
     * @member {String} - Called via CLI (`cli`) or Programmatically (`script`)
     * @default "script"
     */
    this.source = options.source || "script";

    /**
     * @member {Boolean} - Running in serverless mode
     * @default false
     */
    if ("isServerless" in options) {
      this.isServerless = !!options.isServerless;
    } else {
      this.isServerless = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    }

    /**
     * @member {String} - One of build, serve, or watch
     * @default "build"
     */
    this.runMode = options.runMode || "build";

    /**
     * @member {Object} - Initialize Eleventy environment variables
     * @default null
     */
    // both this.isServerless and this.runMode need to be set before this
    this.env = this.getEnvironmentVariableValues();
    this.initializeEnvironmentVariables(this.env);

    /**
     * @member {Object} - Initialize Eleventy’s configuration, including the user config file
     */
    this.config = this.eleventyConfig.getConfig();

    /**
     * @member {Object} - Singleton BenchmarkManager instance
     */
    this.bench = this.config.benchmarkManager;

    /**
     * @member {Boolean} - Was verbose mode overwritten?
     * @default false
     */
    this.verboseModeSetViaCommandLineParam = false;

    /**
     * @member {Boolean} - Is Eleventy running in verbose mode?
     * @default true
     */
    if (options.quietMode === true || options.quietMode === false) {
      // Set via --quiet
      this.setIsVerbose(!options.quietMode);
      this.verboseModeSetViaCommandLineParam = true;
    } else {
      // Fall back to configuration
      this.setIsVerbose(!this.config.quietMode);
    }

    /**
     * @member {Boolean} - Is Eleventy running in dry mode?
     * @default false
     */
    this.isDryRun = false;

    /**
     * @member {Boolean} - Does the init() method still need to be run (or hasn’t finished yet)
     * @default true
     */
    this.needsInit = true;

    /**
     * @member {Boolean} - Explicit input directory (usually used when input is a single file/serverless)
     */
    if (options.inputDir) {
      this.setInputDir(options.inputDir);
    }

    if (performance) {
      // TODO this doesn’t reset in serverless mode correctly (cumulative from start of --serve/watch)
      debug("Eleventy warm up time (in ms) %o", performance.now());
    }

    /** @member {Number} - The timestamp of Eleventy start. */
    this.start = this.getNewTimestamp();

    /**
     * @member {Array<String>} - Subset of template types.
     * @default null
     */
    this.formatsOverride = null;

    /** @member {Object} - tbd. */
    this.eleventyServe = new EleventyServe();
    this.eleventyServe.config = this.config;
    this.eleventyServe.eleventyConfig = this.eleventyConfig;

    /** @member {String} - Holds the path to the input directory. */
    this.rawInput = input;

    /** @member {String} - Holds the path to the output directory. */
    this.rawOutput = output;

    /** @member {Object} - tbd. */
    this.watchManager = new EleventyWatch();

    /** @member {Object} - tbd. */
    this.watchTargets = new EleventyWatchTargets();
    this.watchTargets.addAndMakeGlob(this.config.additionalWatchTargets);
    this.watchTargets.watchJavaScriptDependencies = this.config.watchJavaScriptDependencies;

    /** @member {Object} - tbd. */
    this.fileSystemSearch = new FileSystemSearch();

    this.isIncremental = false;
    this.programmaticApiIncrementalFile = undefined;
    this.isRunInitialBuild = true;
  }

  getNewTimestamp() {
    if (performance) {
      return performance.now();
    }
    return new Date().getTime();
  }

  /** @type {String} */
  get input() {
    return this.rawInput || this.config.dir.input;
  }

  /** @type {String} */
  get inputDir() {
    if (this._inputDir) {
      // set manually via setter
      return this._inputDir;
    }

    return TemplatePath.getDir(this.input);
  }

  setInputDir(dir) {
    this._inputDir = dir;
  }

  /** @type {String} */
  get outputDir() {
    return this.rawOutput || this.config.dir.output;
  }

  /**
   * Updates the dry-run mode of Eleventy.
   *
   * @method
   * @param {Boolean} isDryRun - Shall Eleventy run in dry mode?
   */
  setDryRun(isDryRun) {
    this.isDryRun = !!isDryRun;
  }

  /**
   * Sets the incremental build mode.
   *
   * @method
   * @param {Boolean} isIncremental - Shall Eleventy run in incremental build mode and only write the files that trigger watch updates
   */
  setIncrementalBuild(isIncremental) {
    this.isIncremental = !!isIncremental;
    this.watchManager.incremental = !!isIncremental;
  }

  /**
   * Set whether or not to do an initial build
   *
   * @method
   * @param {Boolean} ignoreInitialBuild - Shall Eleventy ignore the default initial build before watching in watch/serve mode?
   * @default true
   */
  setIgnoreInitial(ignoreInitialBuild) {
    this.isRunInitialBuild = !ignoreInitialBuild;
  }

  /**
   * Updates the path prefix used in the config.
   *
   * @method
   * @param {String} pathPrefix - The new path prefix.
   */
  setPathPrefix(pathPrefix) {
    if (pathPrefix || pathPrefix === "") {
      this.eleventyConfig.setPathPrefix(pathPrefix);
      this.config = this.eleventyConfig.getConfig();
    }
  }

  /**
   * Updates the watch targets.
   *
   * @method
   * @param {} watchTargets - The new watch targets.
   */
  setWatchTargets(watchTargets) {
    this.watchTargets = watchTargets;
  }

  /**
   * Restarts Eleventy.
   *
   * @async
   * @method
   */
  async restart() {
    debug("Restarting");
    this.start = this.getNewTimestamp();

    this.bench.reset();
    this.eleventyFiles.restart();
    this.extensionMap.reset();
  }

  /**
   * Logs some statistics after a complete run of Eleventy.
   *
   * @method
   * @returns {String} ret - The log message.
   */
  logFinished() {
    if (!this.writer) {
      throw new Error(
        "Did you call Eleventy.init to create the TemplateWriter instance? Hint: you probably didn’t."
      );
    }

    let ret = [];

    let writeCount = this.writer.getWriteCount();
    let skippedCount = this.writer.getSkippedCount();
    let copyCount = this.writer.getCopyCount();

    let slashRet = [];

    if (copyCount) {
      slashRet.push(`Copied ${copyCount} ${simplePlural(copyCount, "file", "files")}`);
    }

    slashRet.push(
      `Wrote ${writeCount} ${simplePlural(writeCount, "file", "files")}${
        skippedCount ? ` (skipped ${skippedCount})` : ""
      }`
    );

    if (slashRet.length) {
      ret.push(slashRet.join(" / "));
    }

    let versionStr = `v${pkg.version}`;
    let time = ((this.getNewTimestamp() - this.start) / 1000).toFixed(2);
    ret.push(`in ${time} ${simplePlural(time, "second", "seconds")}`);

    if (writeCount >= 10) {
      ret.push(`(${((time * 1000) / writeCount).toFixed(1)}ms each, ${versionStr})`);
    } else {
      ret.push(`(${versionStr})`);
    }

    return ret.join(" ");
  }

  _cache(key, inst) {
    if (!this._privateCaches) {
      this._privateCaches = new Map();
    }

    if (!("caches" in inst)) {
      throw new Error("To use _cache you need a `caches` getter object");
    }

    // Restore from cache
    if (this._privateCaches.has(key)) {
      let c = this._privateCaches.get(key);
      for (let cacheKey in c) {
        inst[cacheKey] = c[cacheKey];
      }
    } else {
      // Set cache
      let c = {};
      for (let cacheKey of inst.caches || []) {
        c[cacheKey] = inst[cacheKey];
      }
      this._privateCaches.set(key, c);
    }
  }

  /**
   * Starts Eleventy.
   *
   * @async
   * @method
   * @returns {} - tbd.
   */
  async init(options = {}) {
    options = Object.assign({ viaConfigReset: false }, options);

    await this.config.events.emit("eleventy.config", this.eleventyConfig);

    if (this.env) {
      await this.config.events.emit("eleventy.env", this.env);
    }

    this.config.inputDir = this.inputDir;

    let formats = this.formatsOverride || this.config.templateFormats;
    this.extensionMap = new EleventyExtensionMap(formats, this.eleventyConfig);
    await this.config.events.emit("eleventy.extensionmap", this.extensionMap);

    // eleventyServe is always available, even when not in --serve mode
    this.eleventyServe.setOutputDir(this.outputDir);

    // TODO
    // this.eleventyServe.setWatcherOptions(this.getChokidarConfig());

    this.templateData = new TemplateData(this.inputDir, this.eleventyConfig);
    this.templateData.extensionMap = this.extensionMap;
    if (this.env) {
      this.templateData.environmentVariables = this.env;
    }
    this.templateData.setFileSystemSearch(this.fileSystemSearch);

    this.eleventyFiles = new EleventyFiles(
      this.inputDir,
      this.outputDir,
      formats,
      this.eleventyConfig
    );
    this.eleventyFiles.setFileSystemSearch(this.fileSystemSearch);
    this.eleventyFiles.setInput(this.inputDir, this.input);
    this.eleventyFiles.setRunMode(this.runMode);
    this.eleventyFiles.extensionMap = this.extensionMap;
    // This needs to be set before init or it’ll construct a new one
    this.eleventyFiles.templateData = this.templateData;
    this.eleventyFiles.init();

    if (checkPassthroughCopyBehavior(this.config, this.runMode)) {
      this.eleventyServe.watchPassthroughCopy(
        this.eleventyFiles.getGlobWatcherFilesForPassthroughCopy()
      );
    }

    this.writer = new TemplateWriter(
      this.inputDir,
      this.outputDir,
      formats,
      this.templateData,
      this.eleventyConfig
    );

    if (!options.viaConfigReset) {
      this._cache("TemplateWriter", this.writer);
    }

    this.writer.setInput(this.inputDir, this.input);
    this.writer.logger = this.logger;
    this.writer.extensionMap = this.extensionMap;
    this.writer.setEleventyFiles(this.eleventyFiles);

    this.writer.setRunInitialBuild(this.isRunInitialBuild);
    this.writer.setIncrementalBuild(this.isIncremental);

    let dirs = {
      input: this.inputDir,
      data: this.templateData.getDataDir(),
      includes: this.eleventyFiles.getIncludesDir(),
      layouts: this.eleventyFiles.getLayoutsDir(),
      output: this.outputDir,
    };

    debug(`Directories:
Input (Dir): ${dirs.input}
Input (File): ${this.rawInput}
Data: ${dirs.data}
Includes: ${dirs.includes}
Layouts: ${dirs.layouts}
Output: ${dirs.output}
Template Formats: ${formats.join(",")}
Verbose Output: ${this.verboseMode}`);

    this.writer.setVerboseOutput(this.verboseMode);
    this.writer.setDryRun(this.isDryRun);

    this.config.events.emit("eleventy.directories", dirs);

    this.needsInit = false;
  }

  // These are all set as initial global data under eleventy.env.* (see TemplateData->environmentVariables)
  getEnvironmentVariableValues() {
    let values = {
      source: this.source,
      runMode: this.runMode,
    };
    let configPath = this.eleventyConfig.getLocalProjectConfigFile();
    if (configPath) {
      let absolutePathToConfig = TemplatePath.absolutePath(configPath);
      values.config = absolutePathToConfig;

      // TODO(zachleat): if config is not in root (e.g. using --config=)
      let root = TemplatePath.getDirFromFilePath(absolutePathToConfig);
      values.root = root;
    }

    values.source = this.source;
    values.isServerless = this.isServerless;

    return values;
  }

  /**
   * Set process.ENV variables for use in Eleventy projects
   *
   * @method
   */
  initializeEnvironmentVariables(env) {
    process.env.ELEVENTY_ROOT = env.root;
    debug("Setting process.env.ELEVENTY_ROOT: %o", env.root);

    process.env.ELEVENTY_SOURCE = env.source;
    process.env.ELEVENTY_RUN_MODE = env.runMode;

    // https://github.com/11ty/eleventy/issues/1957
    // Note: when using --serve, ELEVENTY_SERVERLESS is also set in Serverless.js

    // Careful here, setting to false will cast to string "false" which is truthy.
    if (env.isServerless) {
      process.env.ELEVENTY_SERVERLESS = true;
      debug("Setting process.env.ELEVENTY_SERVERLESS: %o", true);
    }
  }

  /* Setter for verbose mode */
  set verboseMode(value) {
    this._isVerboseMode = !!value;

    if (this.writer) {
      this.writer.setVerboseOutput(this._isVerboseMode);
    }

    this.bench.setVerboseOutput(this._isVerboseMode);

    if (this.logger) {
      this.logger.isVerbose = this._isVerboseMode;
    }

    if (this.errorHandler) {
      this.errorHandler.isVerbose = this._isVerboseMode;
    }
  }

  /* Getter for verbose mode */
  get verboseMode() {
    return this._isVerboseMode;
  }

  /* Getter for Logger */
  get logger() {
    if (!this._logger) {
      this._logger = new ConsoleLogger();
      this._logger.isVerbose = this.verboseMode;
    }

    return this._logger;
  }

  /* Setter for Logger */
  set logger(logger) {
    this.eleventyConfig.setLogger(logger);
    this._logger = logger;
  }

  disableLogger() {
    this._logger.overrideLogger(false);
  }

  /* Getter for error handler */
  get errorHandler() {
    if (!this._errorHandler) {
      this._errorHandler = new EleventyErrorHandler();
      this._errorHandler.isVerbose = this.verboseMode;
      this._errorHandler.logger = this.logger;
    }

    return this._errorHandler;
  }

  /**
   * Updates the verbose mode of Eleventy.
   *
   * @method
   * @param {Boolean} isVerbose - Shall Eleventy run in verbose mode?
   */
  setIsVerbose(isVerbose) {
    // Debug mode should always run quiet (all output goes to debug logger)
    if (process.env.DEBUG) {
      isVerbose = false;
    }
    if (this.logger) {
      this.logger.isVerbose = isVerbose;
    }

    this.bench.setVerboseOutput(isVerbose);
    this.verboseMode = isVerbose;

    // Set verbose mode in config file
    this.eleventyConfig.verbose = this.verboseMode;
  }

  /**
   * Updates the template formats of Eleventy.
   *
   * @method
   * @param {String} formats - The new template formats.
   */
  setFormats(formats) {
    if (formats && formats !== "*") {
      this.formatsOverride = formats.split(",");
    }
  }

  /**
   * Updates the run mode of Eleventy.
   *
   * @method
   * @param {String} runMode - One of "build", "watch", or "serve"
   */
  setRunMode(runMode) {
    this.runMode = runMode;
  }

  /**
   * Set the file that needs to be rendered/compiled/written for an incremental build.
   * This method is part of the programmatic API and is not used internally.
   *
   * @method
   * @param {String} incrementalFile - File path (added or modified in a project)
   */
  setIncrementalFile(incrementalFile) {
    if (incrementalFile) {
      // This is used for collections-friendly serverless mode.
      this.setIgnoreInitial(true);
      this.setIncrementalBuild(true);

      this.programmaticApiIncrementalFile = incrementalFile;
    }
  }

  /**
   * Reads the version of Eleventy.
   *
   * @static
   * @returns {String} - The version of Eleventy.
   */
  static getVersion() {
    return pkg.version;
  }

  /**
   * @deprecated since 1.0.1, use static Eleventy.getVersion()
   */
  getVersion() {
    return Eleventy.getVersion();
  }

  /**
   * Shows a help message including usage.
   *
   * @static
   * @returns {String} - The help mesage.
   */
  static getHelp() {
    return `Usage: eleventy
       eleventy --input=. --output=./_site
       eleventy --serve

Arguments:

     --version

     --input=.
       Input template files (default: \`.\`)

     --output=_site
       Write HTML output to this folder (default: \`_site\`)

     --serve
       Run web server on --port (default 8080) and watch them too

     --port
       Run the --serve web server on this port (default 8080)

     --watch
       Wait for files to change and automatically rewrite (no web server)

     --ignore-initial
       Start without a build; build when files change. Works best with watch/serve/incremental.

     --formats=liquid,md
       Whitelist only certain template types (default: \`*\`)

     --quiet
       Don’t print all written files (off by default)

     --config=filename.js
       Override the eleventy config file path (default: \`.eleventy.js\`)

     --pathprefix='/'
       Change all url template filters to use this subdirectory.

     --dryrun
       Don’t write any files. Useful with \`DEBUG=Eleventy* npx eleventy\`

     --to=json
     --to=ndjson
       Change the output to JSON or NDJSON (default: \`fs\`)

     --help`;
  }

  /**
   * @deprecated since 1.0.1, use static Eleventy.getHelp()
   */
  getHelp() {
    return Eleventy.getHelp();
  }

  /**
   * Resets the config of Eleventy.
   *
   * @method
   */
  resetConfig() {
    this.env = this.getEnvironmentVariableValues();
    this.initializeEnvironmentVariables(this.env);

    this.eleventyConfig.reset();

    this.config = this.eleventyConfig.getConfig();
    this.eleventyServe.config = this.config;
    this.eleventyServe.eleventyConfig = this.eleventyConfig;

    // only use config quietMode if --quiet not set on CLI
    if (!this.verboseModeSetViaCommandLineParam) {
      this.setIsVerbose(!this.config.quietMode);
    }
  }

  /**
   * tbd.
   *
   * @private
   * @method
   * @param {String} changedFilePath - File that triggered a re-run (added or modified)
   */
  async _addFileToWatchQueue(changedFilePath) {
    // Note: this is a sync event!
    eventBus.emit("eleventy.resourceModified", changedFilePath);
    this.watchManager.addToPendingQueue(changedFilePath);
  }

  _shouldResetConfig() {
    let configFilePaths = this.eleventyConfig.getLocalProjectConfigFiles();
    let configFilesChanged = this.watchManager.hasQueuedFiles(configFilePaths);

    if (configFilesChanged) {
      return true;
    }

    for (const configFilePath of configFilePaths) {
      // Any dependencies of the config file changed
      let configFileDependencies = this.watchTargets.getDependenciesOf(configFilePath);

      for (let dep of configFileDependencies) {
        if (this.watchManager.hasQueuedFile(dep)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * tbd.
   *
   * @private
   * @method
   */
  async _watch() {
    if (this.watchManager.isBuildRunning()) {
      return;
    }

    this.watchManager.setBuildRunning();

    let queue = this.watchManager.getActiveQueue();
    await this.config.events.emit("beforeWatch", queue);
    await this.config.events.emit("eleventy.beforeWatch", queue);

    // Clear `require` cache for all files that triggered the rebuild
    this.watchTargets.clearRequireCacheFor(queue);

    // reset and reload global configuration
    let isResetConfig = this._shouldResetConfig();
    if (isResetConfig) {
      this.resetConfig();
    }

    await this.restart();
    await this.init({ viaConfigReset: isResetConfig });

    let incrementalFile = this.watchManager.getIncrementalFile();
    if (incrementalFile) {
      this.writer.setIncrementalFile(incrementalFile);
    }

    let writeResults = await this.write();
    let passthroughCopyResults;
    let templateResults;
    if (!writeResults.error) {
      [passthroughCopyResults, ...templateResults] = writeResults;
    }

    this.writer.resetIncrementalFile();

    this.watchTargets.reset();

    await this._initWatchDependencies();

    // Add new deps to chokidar
    this.watcher.add(this.watchTargets.getNewTargetsSinceLastReset());

    // Is a CSS input file and is not in the includes folder
    // TODO check output path file extension of this template (not input path)
    // TODO add additional API for this, maybe a config callback?
    let onlyCssChanges = this.watchManager.hasAllQueueFiles((path) => {
      return (
        path.endsWith(".css") &&
        // TODO how to make this work with relative includes?
        !TemplatePath.startsWithSubPath(path, this.eleventyFiles.getIncludesDir())
      );
    });

    if (writeResults.error) {
      this.eleventyServe.sendError({
        error: writeResults.error,
      });
    } else {
      let normalizedPathPrefix = PathPrefixer.normalizePathPrefix(this.config.pathPrefix);
      await this.eleventyServe.reload({
        files: this.watchManager.getActiveQueue(),
        subtype: onlyCssChanges ? "css" : undefined,
        build: {
          templates: templateResults
            .flat()
            .filter((entry) => !!entry)
            .map((entry) => {
              entry.url = PathPrefixer.joinUrlParts(normalizedPathPrefix, entry.url);
              return entry;
            }),
        },
      });
    }

    this.watchManager.setBuildFinished();

    let queueSize = this.watchManager.getPendingQueueSize();
    if (queueSize > 0) {
      this.logger.log(
        `You saved while Eleventy was running, let’s run again. (${queueSize} change${
          queueSize !== 1 ? "s" : ""
        })`
      );
      await this._watch();
    } else {
      this.logger.log("Watching…");
    }
  }

  /**
   * tbd.
   *
   * @returns {} - tbd.
   */
  get watcherBench() {
    return this.bench.get("Watcher");
  }

  /**
   * Set up watchers and benchmarks.
   *
   * @async
   * @method
   */
  async initWatch() {
    this.watchManager = new EleventyWatch();
    this.watchManager.incremental = this.isIncremental;

    this.watchTargets.add(["./package.json"]);
    this.watchTargets.add(this.eleventyFiles.getGlobWatcherFiles());
    this.watchTargets.add(this.eleventyFiles.getIgnoreFiles());

    // Watch the local project config file
    this.watchTargets.add(this.eleventyConfig.getLocalProjectConfigFiles());

    // Template and Directory Data Files
    this.watchTargets.add(await this.eleventyFiles.getGlobWatcherTemplateDataFiles());

    let benchmark = this.watcherBench.get(
      "Watching JavaScript Dependencies (disable with `eleventyConfig.setWatchJavaScriptDependencies(false)`)"
    );
    benchmark.before();
    await this._initWatchDependencies();
    benchmark.after();
  }

  /**
   * Starts watching dependencies.
   *
   * @private
   * @async
   * @method
   */
  async _initWatchDependencies() {
    if (!this.watchTargets.watchJavaScriptDependencies) {
      return;
    }

    let dataDir = TemplatePath.stripLeadingDotSlash(this.templateData.getDataDir());
    function filterOutGlobalDataFiles(path) {
      return !dataDir || !TemplatePath.stripLeadingDotSlash(path).startsWith(dataDir);
    }

    // Template files .11ty.js
    let templateFiles = this.eleventyFiles.getWatchPathCache();
    this.watchTargets.addDependencies(templateFiles);

    // Config file dependencies
    this.watchTargets.addDependencies(
      this.eleventyConfig.getLocalProjectConfigFiles(),
      filterOutGlobalDataFiles
    );

    // Deps from Global Data (that aren’t in the global data directory, everything is watched there)
    let globalDataDeps = this.templateData.getWatchPathCache();
    this.watchTargets.addDependencies(globalDataDeps, filterOutGlobalDataFiles);

    this.watchTargets.addDependencies(
      await this.eleventyFiles.getWatcherTemplateJavaScriptDataFiles()
    );
  }

  /**
   * Returns all watched files.
   *
   * @async
   * @method
   * @returns {} targets - The watched files.
   */
  async getWatchedFiles() {
    return this.watchTargets.getTargets();
  }

  getChokidarConfig() {
    let ignores = this.eleventyFiles.getGlobWatcherIgnores();
    debug("Ignoring watcher changes to: %o", ignores);

    let configOptions = this.config.chokidarConfig;

    // can’t override these yet
    // TODO maybe if array, merge the array?
    delete configOptions.ignored;

    return Object.assign(
      {
        ignored: ignores,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 150,
          pollInterval: 25,
        },
      },
      configOptions
    );
  }

  /**
   * Start the watching of files
   *
   * @async
   * @method
   */
  async watch() {
    this.watcherBench.setMinimumThresholdMs(500);
    this.watcherBench.reset();

    // We use a string module name and try/catch here to hide this from the zisi and esbuild serverless bundlers
    let chokidar;
    // eslint-disable-next-line no-useless-catch
    try {
      let moduleName = "chokidar";
      chokidar = require(moduleName);
    } catch (e) {
      throw e;
    }

    // Note that watching indirectly depends on this for fetching dependencies from JS files
    // See: TemplateWriter:pathCache and EleventyWatchTargets
    let result = await this.write();
    if (result.error) {
      // initial build failed—quit watch early
      return Promise.reject(result.error);
    }

    let initWatchBench = this.watcherBench.get("Start up --watch");
    initWatchBench.before();

    await this.initWatch();

    // TODO improve unwatching if JS dependencies are removed (or files are deleted)
    let rawFiles = await this.getWatchedFiles();
    debug("Watching for changes to: %o", rawFiles);

    let watcher = chokidar.watch(rawFiles, this.getChokidarConfig());

    initWatchBench.after();

    this.watcherBench.finish("Watch");

    this.logger.forceLog("Watching…");

    this.watcher = watcher;

    let watchDelay;
    let watchRun = async (path) => {
      path = TemplatePath.normalize(path);
      try {
        this._addFileToWatchQueue(path);
        clearTimeout(watchDelay);

        await new Promise((resolve, reject) => {
          watchDelay = setTimeout(async () => {
            this._watch().then(resolve, reject);
          }, this.config.watchThrottleWaitTime);
        });
      } catch (e) {
        if (e instanceof EleventyBaseError) {
          this.errorHandler.error(e, "Eleventy watch error");
          this.watchManager.setBuildFinished();
        } else {
          this.errorHandler.fatal(e, "Eleventy fatal watch error");
          this.stopWatch();
        }
      }
    };

    watcher.on("change", async (path) => {
      this.logger.forceLog(`File changed: ${path}`);
      await watchRun(path);
    });

    watcher.on("add", async (path) => {
      this.logger.forceLog(`File added: ${path}`);
      this.fileSystemSearch.add(path);
      await watchRun(path);
    });

    watcher.on("unlink", (path) => {
      // this.logger.forceLog(`File removed: ${path}`);
      this.fileSystemSearch.delete(path);
    });

    process.on("SIGINT", () => this.stopWatch());
  }

  stopWatch() {
    debug("Cleaning up chokidar and server instances, if they exist.");
    this.eleventyServe.close();
    this.watcher.close();

    process.exit();
  }

  /**
   * Serve Eleventy on this port.
   *
   * @param {Number} port - The HTTP port to serve Eleventy from.
   */
  async serve(port) {
    // Port is optional and in this case likely via --port on the command line
    // May defer to configuration API options `port` property
    return this.eleventyServe.serve(port);
  }

  /**
   * Writes templates to the file system.
   *
   * @async
   * @method
   * @returns {Promise<{}>}
   */
  async write() {
    return this.executeBuild();
  }

  /**
   * Renders templates to a JSON object.
   *
   * @async
   * @method
   * @returns {Promise<{}>}
   */
  async toJSON() {
    return this.executeBuild("json");
  }

  /**
   * Returns a stream of new line delimited (NDJSON) objects
   *
   * @async
   * @method
   * @returns {Promise<{ReadableStream}>}
   */
  async toNDJSON() {
    return this.executeBuild("ndjson");
  }

  /**
   * tbd.
   *
   * @async
   * @method
   * @returns {Promise<{}>} ret - tbd.
   */
  async executeBuild(to = "fs") {
    if (this.needsInit) {
      if (!this._initing) {
        this._initing = this.init();
      }
      await this._initing;
      this.needsInit = false;
    }

    if (!this.writer) {
      this.errorHandler.fatal(
        new Error(
          "Eleventy didn’t run init() properly and wasn’t able to create a TemplateWriter."
        ),
        "Problem writing Eleventy templates"
      );
    }

    if (this.programmaticApiIncrementalFile) {
      this.writer.setIncrementalFile(this.programmaticApiIncrementalFile);
    }

    let ret;
    let hasError = false;

    try {
      let eventsArg = {
        inputDir: this.config.inputDir,
        dir: this.config.dir,
        runMode: this.runMode,
        outputMode: to,
        incremental: this.isIncremental,
      };
      await this.config.events.emit("beforeBuild", eventsArg);
      await this.config.events.emit("eleventy.before", eventsArg);

      let promise;
      if (to === "fs") {
        promise = this.writer.write();
      } else if (to === "json") {
        promise = this.writer.getJSON("json");
      } else if (to === "ndjson") {
        promise = this.writer.getJSON("ndjson");
      } else {
        throw new Error(
          `Invalid argument for \`Eleventy->executeBuild(${to})\`, expected "json", "ndjson", or "fs".`
        );
      }

      ret = await promise;

      // Passing the processed output to the eleventy.after event is new in 2.0
      let [passthroughCopyResults, ...templateResults] = ret;
      if (to === "fs") {
        eventsArg.results = templateResults.flat().filter((entry) => !!entry);
      } else {
        eventsArg.results = templateResults.filter((entry) => !!entry);
      }

      if (to === "ndjson") {
        // return a stream
        // TODO this might output the ndjson rows only after all the templates have been written to the stream?
        ret = this.logger.closeStream(to);
      }

      await this.config.events.emit("afterBuild", eventsArg);
      await this.config.events.emit("eleventy.after", eventsArg);
    } catch (e) {
      hasError = true;
      ret = {
        error: e,
      };

      // Issue #2405
      if (this.source === "script") {
        this.errorHandler.error(e, "Problem writing Eleventy templates");
        throw e;
      } else {
        this.errorHandler.fatal(e, "Problem writing Eleventy templates");
      }
    } finally {
      this.bench.finish();
      if (to === "fs") {
        this.logger.message(this.logFinished(), "info", hasError ? "red" : "green", true);
      }
      debug("Finished writing templates.");

      debug(`
      Getting frustrated? Have a suggestion/feature request/feedback?
      I want to hear it! Open an issue: https://github.com/11ty/eleventy/issues/new`);
    }

    return ret;
  }
}

module.exports = Eleventy;
module.exports.EleventyServerless = require("./Serverless");
module.exports.EleventyServerlessBundlerPlugin = require("./Plugins/ServerlessBundlerPlugin");
module.exports.EleventyRenderPlugin = require("./Plugins/RenderPlugin");
module.exports.EleventyEdgePlugin = require("./Plugins/EdgePlugin");
module.exports.EleventyI18nPlugin = require("./Plugins/I18nPlugin");
module.exports.EleventyHtmlBasePlugin = require("./Plugins/HtmlBasePlugin");
