import * as path from "path";
import { MANIFEST_FILE_NAME, INCLUDE_GRADLE_NAME, ASSETS_DIR, RESOURCES_DIR, TNS_ANDROID_RUNTIME_NAME, AndroidBuildDefaults } from "../constants";
import { getShortPluginName, hook } from "../common/helpers";
import { Builder, parseString } from "xml2js";
import { ILogger } from "log4js";

export class AndroidPluginBuildService implements IAndroidPluginBuildService {
	/**
	 * Required for hooks execution to work.
	 */
	private get $hooksService(): IHooksService {
		return this.$injector.resolve("hooksService");
	}

	private get $platformService(): IPlatformService {
		return this.$injector.resolve("platformService");
	}

	constructor(private $injector: IInjector,
		private $fs: IFileSystem,
		private $childProcess: IChildProcess,
		private $hostInfo: IHostInfo,
		private $androidToolsInfo: IAndroidToolsInfo,
		private $logger: ILogger,
		private $npm: INodePackageManager,
		private $projectDataService: IProjectDataService,
		private $devicePlatformsConstants: Mobile.IDevicePlatformsConstants,
		private $errors: IErrors) { }

	private static MANIFEST_ROOT = {
		$: {
			"xmlns:android": "http://schemas.android.com/apk/res/android"
		}
	};

	private getAndroidSourceDirectories(source: string): Array<string> {
		const directories = [RESOURCES_DIR, "java", ASSETS_DIR, "jniLibs"];
		const resultArr: Array<string> = [];

		this.$fs.enumerateFilesInDirectorySync(source, (file, stat) => {
			if (stat.isDirectory() && _.some(directories, (element) => file.endsWith(element))) {
				resultArr.push(file);
				return true;
			}
		});

		return resultArr;
	}

	private getManifest(platformsDir: string): string {
		const manifest = path.join(platformsDir, MANIFEST_FILE_NAME);
		return this.$fs.exists(manifest) ? manifest : null;
	}

	private async updateManifestContent(oldManifestContent: string, defaultPackageName: string): Promise<string> {
		let xml: any = await this.getXml(oldManifestContent);

		let packageName = defaultPackageName;
		// if the manifest file is full-featured and declares settings inside the manifest scope
		if (xml["manifest"]) {
			if (xml["manifest"]["$"]["package"]) {
				packageName = xml["manifest"]["$"]["package"];
			}

			// set the xml as the value to iterate over its properties
			xml = xml["manifest"];
		}

		// if the manifest file doesn't have a <manifest> scope, only the first setting will be picked up
		const newManifest: any = { manifest: {} };
		for (const prop in xml) {
			newManifest.manifest[prop] = xml[prop];
		}

		newManifest.manifest["$"]["package"] = packageName;

		const xmlBuilder = new Builder();
		const newManifestContent = xmlBuilder.buildObject(newManifest);

		return newManifestContent;
	}

	private createManifestContent(packageName: string): string {
		const newManifest: any = { manifest: AndroidPluginBuildService.MANIFEST_ROOT };
		newManifest.manifest["$"]["package"] = packageName;
		const xmlBuilder: any = new Builder();
		const newManifestContent = xmlBuilder.buildObject(newManifest);

		return newManifestContent;
	}

	private async getXml(stringContent: string): Promise<any> {
		const promise = new Promise<any>((resolve, reject) =>
			parseString(stringContent, (err: any, result: any) => {
				if (err) {
					reject(err);
				} else {
					resolve(result);
				}
			})
		);

		return promise;
	}

	private getIncludeGradleCompileDependenciesScope(includeGradleFileContent: string): Array<string> {
		const indexOfDependenciesScope = includeGradleFileContent.indexOf("dependencies");
		const result: Array<string> = [];

		if (indexOfDependenciesScope === -1) {
			return result;
		}

		const indexOfRepositoriesScope = includeGradleFileContent.indexOf("repositories");

		let repositoriesScope = "";
		if (indexOfRepositoriesScope >= 0) {
			repositoriesScope = this.getScope("repositories", includeGradleFileContent);
			result.push(repositoriesScope);
		}

		const dependenciesScope = this.getScope("dependencies", includeGradleFileContent);
		result.push(dependenciesScope);

		return result;
	}

	private getScope(scopeName: string, content: string): string {
		const indexOfScopeName = content.indexOf(scopeName);
		let result = "";
		const openingBracket = "{";
		const closingBracket = "}";
		let openBrackets = 0;
		let foundFirstBracket = false;

		let i = indexOfScopeName;
		while (i < content.length) {
			const currCharacter = content[i];
			if (currCharacter === openingBracket) {
				if (openBrackets === 0) {
					foundFirstBracket = true;
				}

				openBrackets++;
			}

			if (currCharacter === closingBracket) {
				openBrackets--;
			}

			result += currCharacter;

			if (openBrackets === 0 && foundFirstBracket) {
				break;
			}

			i++;
		}

		return result;
	}

	/**
	 * Returns whether the build has completed or not
	 * @param {Object} options
	 * @param {string} options.pluginName - The name of the plugin. E.g. 'nativescript-barcodescanner'
	 * @param {string} options.platformsAndroidDirPath - The path to the 'plugin/src/platforms/android' directory.
	 * @param {string} options.aarOutputDir - The path where the aar should be copied after a successful build.
	 * @param {string} options.tempPluginDirPath - The path where the android plugin will be built.
	 */
	public async buildAar(options: IBuildOptions): Promise<boolean> {
		this.validateOptions(options);
		const manifestFilePath = this.getManifest(options.platformsAndroidDirPath);
		const androidSourceDirectories = this.getAndroidSourceDirectories(options.platformsAndroidDirPath);
		const shouldBuildAar = !!manifestFilePath || androidSourceDirectories.length > 0;

		if (shouldBuildAar) {
			const shortPluginName = getShortPluginName(options.pluginName);
			const pluginTempDir = path.join(options.tempPluginDirPath, shortPluginName);
			const pluginTempMainSrcDir = path.join(pluginTempDir, "src", "main");

			await this.updateManifest(manifestFilePath, pluginTempMainSrcDir, shortPluginName);
			this.copySourceSetDirectories(androidSourceDirectories, pluginTempMainSrcDir);
			await this.setupGradle(pluginTempDir, options.platformsAndroidDirPath, options.projectDir);
			await this.buildPlugin({ pluginDir: pluginTempDir, pluginName: options.pluginName });
			this.copyAar(shortPluginName, pluginTempDir, options.aarOutputDir);
		}

		return shouldBuildAar;
	}

	private async updateManifest(manifestFilePath: string, pluginTempMainSrcDir: string, shortPluginName: string): Promise<void> {
		let updatedManifestContent;
		this.$fs.ensureDirectoryExists(pluginTempMainSrcDir);
		const defaultPackageName = "org.nativescript." + shortPluginName;
		if (manifestFilePath) {
			let androidManifestContent;
			try {
				androidManifestContent = this.$fs.readText(manifestFilePath);
			} catch (err) {
				this.$errors.failWithoutHelp(`Failed to fs.readFileSync the manifest file located at ${manifestFilePath}. Error is: ${err.toString()}`);
			}

			updatedManifestContent = await this.updateManifestContent(androidManifestContent, defaultPackageName);
		} else {
			updatedManifestContent = this.createManifestContent(defaultPackageName);
		}

		const pathToTempAndroidManifest = path.join(pluginTempMainSrcDir, MANIFEST_FILE_NAME);
		try {
			this.$fs.writeFile(pathToTempAndroidManifest, updatedManifestContent);
		} catch (e) {
			this.$errors.failWithoutHelp(`Failed to write the updated AndroidManifest in the new location - ${pathToTempAndroidManifest}. Error is: ${e.toString()}`);
		}
	}

	private copySourceSetDirectories(androidSourceSetDirectories: string[], pluginTempMainSrcDir: string): void {
		for (const dir of androidSourceSetDirectories) {
			const dirName = path.basename(dir);
			const destination = path.join(pluginTempMainSrcDir, dirName);

			this.$fs.ensureDirectoryExists(destination);
			this.$fs.copyFile(path.join(dir, "*"), destination);
		}
	}

	private async setupGradle(pluginTempDir: string, platformsAndroidDirPath: string, projectDir: string): Promise<void> {
		const gradleTemplatePath = path.resolve(path.join(__dirname, "../../vendor/gradle-plugin"));
		const allGradleTemplateFiles = path.join(gradleTemplatePath, "*");
		const buildGradlePath = path.join(pluginTempDir, "build.gradle");

		this.$fs.copyFile(allGradleTemplateFiles, pluginTempDir);
		this.addCompileDependencies(platformsAndroidDirPath, buildGradlePath);
		const runtimeGradleVersions = await this.getRuntimeGradleVersions(projectDir);
		this.replaceGradleVersion(pluginTempDir, runtimeGradleVersions.gradleVersion);
		this.replaceGradleAndroidPluginVersion(buildGradlePath, runtimeGradleVersions.gradleAndroidPluginVersion);
	}

	private async getRuntimeGradleVersions(projectDir: string): Promise<IRuntimeGradleVersions> {
		const registryData = await this.$npm.getRegistryPackageData(TNS_ANDROID_RUNTIME_NAME);
		let runtimeGradleVersions: IRuntimeGradleVersions = null;
		if (projectDir) {
			const projectRuntimeVersion = this.$platformService.getCurrentPlatformVersion(
				this.$devicePlatformsConstants.Android,
				this.$projectDataService.getProjectData(projectDir));
			runtimeGradleVersions = this.getGradleVersions(registryData.versions[projectRuntimeVersion]);
			this.$logger.trace(`Got gradle versions ${JSON.stringify(runtimeGradleVersions)} from runtime v${projectRuntimeVersion}`);
		}

		if (!runtimeGradleVersions) {
			const latestRuntimeVersion = registryData["dist-tags"].latest;
			runtimeGradleVersions = this.getGradleVersions(registryData.versions[latestRuntimeVersion]);
			this.$logger.trace(`Got gradle versions ${JSON.stringify(runtimeGradleVersions)} from the latest runtime v${latestRuntimeVersion}`);
		}

		return runtimeGradleVersions || {};
	}

	private getGradleVersions(packageData: { gradle: { version: string, android: string }}): IRuntimeGradleVersions {
		const packageJsonGradle = packageData && packageData.gradle;
		let runtimeVersions: IRuntimeGradleVersions = null;
		if (packageJsonGradle && (packageJsonGradle.version || packageJsonGradle.android)) {
			runtimeVersions = {};
			runtimeVersions.gradleVersion = packageJsonGradle.version;
			runtimeVersions.gradleAndroidPluginVersion = packageJsonGradle.android;
		}

		return runtimeVersions;
	}

	private replaceGradleVersion(pluginTempDir: string, version: string): void {
		const gradleVersion = version || AndroidBuildDefaults.GradleVersion;
		const gradleVersionPlaceholder = "{{runtimeGradleVersion}}";
		const gradleWrapperPropertiesPath = path.join(pluginTempDir, "gradle", "wrapper", "gradle-wrapper.properties");

		this.replaceFileContent(gradleWrapperPropertiesPath, gradleVersionPlaceholder, gradleVersion);
	}

	private replaceGradleAndroidPluginVersion(buildGradlePath: string, version: string): void {
		const gradleAndroidPluginVersionPlaceholder = "{{runtimeAndroidPluginVersion}}";
		const gradleAndroidPluginVersion = version || AndroidBuildDefaults.GradleAndroidPluginVersion;

		this.replaceFileContent(buildGradlePath, gradleAndroidPluginVersionPlaceholder, gradleAndroidPluginVersion);
	}

	private replaceFileContent(filePath: string, content: string, replacement: string) {
		const fileContent = this.$fs.readText(filePath);
		const contentRegex = new RegExp(content, "g");
		const replacedFileContent = fileContent.replace(contentRegex, replacement);
		this.$fs.writeFile(filePath, replacedFileContent);
	}

	private addCompileDependencies(platformsAndroidDirPath: string, buildGradlePath: string): void {
		const includeGradlePath = path.join(platformsAndroidDirPath, INCLUDE_GRADLE_NAME);
		if (this.$fs.exists(includeGradlePath)) {
			const includeGradleContent = this.$fs.readText(includeGradlePath);
			const compileDependencies = this.getIncludeGradleCompileDependenciesScope(includeGradleContent);

			if (compileDependencies.length) {
				this.$fs.appendFile(buildGradlePath, "\n" + compileDependencies.join("\n"));
			}
		}
	}

	private copyAar(shortPluginName: string, pluginTempDir: string, aarOutputDir: string): void {
		const finalAarName = `${shortPluginName}-release.aar`;
		const pathToBuiltAar = path.join(pluginTempDir, "build", "outputs", "aar", finalAarName);

		if (this.$fs.exists(pathToBuiltAar)) {
			try {
				if (aarOutputDir) {
					this.$fs.copyFile(pathToBuiltAar, path.join(aarOutputDir, `${shortPluginName}.aar`));
				}
			} catch (e) {
				this.$errors.failWithoutHelp(`Failed to copy built aar to destination. ${e.message}`);
			}
		} else {
			this.$errors.failWithoutHelp(`No built aar found at ${pathToBuiltAar}`);
		}
	}

	/**
	 * @param {Object} options
	 * @param {string} options.platformsAndroidDirPath - The path to the 'plugin/src/platforms/android' directory.
	 */
	public migrateIncludeGradle(options: IBuildOptions): boolean {
		this.validatePlatformsAndroidDirPathOption(options);

		const includeGradleFilePath = path.join(options.platformsAndroidDirPath, INCLUDE_GRADLE_NAME);

		if (this.$fs.exists(includeGradleFilePath)) {
			let includeGradleFileContent: string;
			try {
				includeGradleFileContent = this.$fs.readFile(includeGradleFilePath).toString();
			} catch (err) {
				this.$errors.failWithoutHelp(`Failed to fs.readFileSync the include.gradle file located at ${includeGradleFilePath}. Error is: ${err.toString()}`);
			}

			const productFlavorsScope = this.getScope("productFlavors", includeGradleFileContent);

			try {
				const newIncludeGradleFileContent = includeGradleFileContent.replace(productFlavorsScope, "");
				this.$fs.writeFile(includeGradleFilePath, newIncludeGradleFileContent);

				return true;
			} catch (e) {
				this.$errors.failWithoutHelp(`Failed to write the updated include.gradle ` +
					`in - ${includeGradleFilePath}. Error is: ${e.toString()}`);
			}
		}

		return false;
	}

	@hook("buildAndroidPlugin")
	private async buildPlugin(pluginBuildSettings: IBuildAndroidPluginData): Promise<void> {
		if (!pluginBuildSettings.androidToolsInfo) {
			this.$androidToolsInfo.validateInfo({ showWarningsAsErrors: true, validateTargetSdk: true });
			pluginBuildSettings.androidToolsInfo = this.$androidToolsInfo.getToolsInfo();
		}

		const gradlew = this.$hostInfo.isWindows ? "gradlew.bat" : "./gradlew";

		const localArgs = [
			"-p",
			pluginBuildSettings.pluginDir,
			"assembleRelease",
			`-PcompileSdk=android-${pluginBuildSettings.androidToolsInfo.compileSdkVersion}`,
			`-PbuildToolsVersion=${pluginBuildSettings.androidToolsInfo.buildToolsVersion}`,
			`-PsupportVersion=${pluginBuildSettings.androidToolsInfo.supportRepositoryVersion}`
		];

		try {
			await this.$childProcess.spawnFromEvent(gradlew, localArgs, "close", { cwd: pluginBuildSettings.pluginDir });
		} catch (err) {
			this.$errors.failWithoutHelp(`Failed to build plugin ${pluginBuildSettings.pluginName} : \n${err}`);
		}
	}

	private validateOptions(options: IBuildOptions): void {
		if (!options) {
			this.$errors.failWithoutHelp("Android plugin cannot be built without passing an 'options' object.");
		}

		if (!options.pluginName) {
			this.$logger.info("No plugin name provided, defaulting to 'myPlugin'.");
		}

		if (!options.aarOutputDir) {
			this.$logger.info("No aarOutputDir provided, defaulting to the build outputs directory of the plugin");
		}

		if (!options.tempPluginDirPath) {
			this.$errors.failWithoutHelp("Android plugin cannot be built without passing the path to a directory where the temporary project should be built.");
		}

		this.validatePlatformsAndroidDirPathOption(options);
	}

	private validatePlatformsAndroidDirPathOption(options: IBuildOptions): void {
		if (!options) {
			this.$errors.failWithoutHelp("Android plugin cannot be built without passing an 'options' object.");
		}

		if (!options.platformsAndroidDirPath) {
			this.$errors.failWithoutHelp("Android plugin cannot be built without passing the path to the platforms/android dir.");
		}
	}

}

$injector.register("androidPluginBuildService", AndroidPluginBuildService);
