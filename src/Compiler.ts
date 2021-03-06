import { BuildIncremental, Service, startService } from "esbuild";
import path from "path";
import ts from "typescript";
import { log, time } from "./utils";

/** Implements TypeScript building using esbuild */
export class Compiler {
  service!: Service;

  // a list of incremental esbuilds we're maintaining right now, one for each tsconfig.json / typescript project required by the process
  builds: BuildIncremental[] = [];

  // a map from filename to which build is responsible for it
  fileMap: { [filename: string]: BuildIncremental } = {};

  // a map from a tsconfig file to which build is responsible for it
  tsConfigMap: { [filename: string]: BuildIncremental } = {};

  // a map from filename to which group of files are being built alongside it
  groupMap: { [filename: string]: string[] } = {};

  constructor(readonly workspaceRoot: string, readonly workDir: string) {}

  async boot() {
    this.service = await startService();
  }

  /**
   * When a file operation occurs that requires setting up all the esbuild builds again, we run this.
   * The operations that should cause an invalidation are:
   *  - a change in the tsconfig.json
   *  - any new file being added
   *  - any existing file being deleted
   *
   * The set of files being built changing causes a reset because esbuild is only incremental over the exact same set of input options passed to it, which includes the files. So we need
   */
  async invalidateBuildSet() {
    await Promise.all(this.builds.map((build) => build.rebuild.dispose()));
    this.builds = [];
    this.fileMap = {};
    this.tsConfigMap = {};
  }

  /**
   * Start compiling a new file at `filename`. Returns the destination that file's compiled output will be found at in the workdir
   **/
  async compile(filename: string) {
    await this.startBuilding(filename);
    return this.destination(filename);
  }

  /**
   * For a given input filename, return all the destinations of the files compiled alongside it in it's compilation group
   **/
  fileGroup(filename: string) {
    const files = this.groupMap[filename];
    return Object.fromEntries(files.map((file) => [file, this.destination(file)]));
  }

  stop() {
    this.service.stop();
  }

  async rebuild() {
    const duration = await time(async () => {
      await Promise.all(this.builds.map((build) => this.reportESBuildErrors(() => build.rebuild())));
    });

    log.debug("rebuild", {
      duration,
    });
  }

  private async getTSConfig(filename: string) {
    const tsConfigFile = ts.findConfigFile(filename, ts.sys.fileExists, "tsconfig.json");

    if (!tsConfigFile) throw new Error(`couldnt find tsconfig.json near ${filename}`);

    const configFile = ts.readConfigFile(tsConfigFile, ts.sys.readFile);
    const tsConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsConfigFile));

    if (tsConfig.errors && tsConfig.errors.length > 0) {
      throw new Error(tsConfig.errors.map((error) => error.messageText).join("\n"));
    }

    return {
      tsConfigFile,
      tsConfig,
    };
  }

  /**
   * Begins building a new file by starting up an incremental esbuild build for the whole project that file belongs to.
   * If a file is part of a project we've seen before, it's a no-op.
   **/
  private async startBuilding(filename: string) {
    if (this.fileMap[filename]) return;
    const { tsConfig, tsConfigFile } = await this.getTSConfig(filename);
    if (this.tsConfigMap[tsConfigFile]) return;

    let fileNames: string[];
    if (process.platform === "win32") {
      fileNames = tsConfig.fileNames.map(e => e.replace(/\//g, "\\"));
    } else {
      fileNames = tsConfig.fileNames;
    }

    await this.reportESBuildErrors(async () => {
      const build = await this.service.build({
        entryPoints: [...fileNames],
        incremental: true,
        bundle: false,
        platform: "node",
        format: "cjs",
        target: ["node14"],
        outdir: this.workDir,
        outbase: this.workspaceRoot,
        tsconfig: tsConfigFile,
        sourcemap: "inline",
      });

      this.tsConfigMap[tsConfigFile] = build;

      log.debug("started build", {
        root: tsConfigFile,
        promptedBy: filename,
        files: fileNames.length,
      });

      this.builds.push(build);

      for (const file of fileNames) {
        this.fileMap[file] = build;
        this.groupMap[file] = fileNames;
      }

      return fileNames;
    });
  }

  private async reportESBuildErrors<T>(run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      log.error(error);
    }
  }

  private destination = (filename: string) => {
    return path.join(this.workDir, filename.replace(this.workspaceRoot, "").replace(/.tsx?$/, ".js"));
  };
}
