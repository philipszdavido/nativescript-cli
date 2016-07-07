import {ApplicationManagerBase} from "../../application-manager-base";
import Future = require("fibers/future");
import * as path from "path";
import * as temp from "temp";

export class IOSSimulatorApplicationManager extends ApplicationManagerBase {
	constructor(private iosSim: any,
		private identifier: string,
		private $options: ICommonOptions,
		private $fs: IFileSystem,
		private $bplistParser: IBinaryPlistParser,
		$logger: ILogger) {
		super($logger);
	}

	public getInstalledApplications(): IFuture<string[]> {
		return Future.fromResult(this.iosSim.getInstalledApplications(this.identifier));
	}

	public installApplication(packageFilePath: string): IFuture<void> {
		return (() => {
			if (this.$fs.exists(packageFilePath).wait() && path.extname(packageFilePath) === ".zip") {
				temp.track();
				let dir = temp.mkdirSync("simulatorPackage");
				this.$fs.unzip(packageFilePath, dir).wait();
				let app = _.find(this.$fs.readDirectory(dir).wait(), directory => path.extname(directory) === ".app");
				if (app) {
					packageFilePath = path.join(dir, app);
				}
			}

			this.iosSim.installApplication(this.identifier, packageFilePath).wait();
		}).future<void>()();
	}

	public uninstallApplication(appIdentifier: string): IFuture<void> {
		return this.iosSim.uninstallApplication(this.identifier, appIdentifier);
	}

	public startApplication(appIdentifier: string): IFuture<void> {
		return (() => {
			let launchResult = this.iosSim.startApplication(this.identifier, appIdentifier).wait();
			if (!this.$options.justlaunch) {
				this.iosSim.printDeviceLog(this.identifier, launchResult);
			}

		}).future<void>()();
	}

	public stopApplication(cfBundleExecutable: string): IFuture<void> {
		return this.iosSim.stopApplication(this.identifier, cfBundleExecutable);
	}

	public canStartApplication(): boolean {
		return true;
	}

	public getApplicationInfo(applicationIdentifier: string): IFuture<Mobile.IApplicationInfo> {
		return ((): Mobile.IApplicationInfo => {
			let result: Mobile.IApplicationInfo = null,
				plistContent = this.getParsedPlistContent(applicationIdentifier).wait();

			if(plistContent) {
				result = {
					applicationIdentifier,
					deviceIdentifier: this.identifier,
					configuration: plistContent && plistContent.configuration
				};
			}

			return result;
		}).future<Mobile.IApplicationInfo>()();
	}

	public isLiveSyncSupported(appIdentifier: string): IFuture<boolean> {
		return ((): boolean => {
			let plistContent = this.getParsedPlistContent(appIdentifier).wait();
			if(plistContent) {
				return !!plistContent && !!plistContent.IceniumLiveSyncEnabled;
			}

			return false;
		}).future<boolean>()();
	}

	private getParsedPlistContent(appIdentifier: string): any {
		return ((): any => {
			let applicationPath = this.iosSim.getApplicationPath(this.identifier, appIdentifier),
				pathToInfoPlist = path.join(applicationPath, "Info.plist");

			return this.$fs.exists(pathToInfoPlist).wait() ? this.$bplistParser.parseFile(pathToInfoPlist).wait()[0] : null;
		}).future<any>()();
	}

	public getDebuggableApps(): IFuture<Mobile.IDeviceApplicationInformation[]> {
		return Future.fromResult([]);
	}
}