import * as path from "path";
import * as temp from "temp";

export class AndroidDeviceHashService implements Mobile.IAndroidDeviceHashService {
	private static HASH_FILE_NAME = "hashes";
	private static DEVICE_ROOT_PATH = "/data/local/tmp";

	private _hashFileDevicePath: string = null;
	private _hashFileLocalPath: string = null;
	private _tempDir: string = null;

	constructor(private adb: Mobile.IDeviceAndroidDebugBridge,
		private appIdentifier: string,
		private $fs: IFileSystem,
		private $mobileHelper: Mobile.IMobileHelper) { }

	public get hashFileDevicePath(): string {
		if (!this._hashFileDevicePath) {
			this._hashFileDevicePath = this.$mobileHelper.buildDevicePath(AndroidDeviceHashService.DEVICE_ROOT_PATH, this.appIdentifier, AndroidDeviceHashService.HASH_FILE_NAME);
		}

		return this._hashFileDevicePath;
	}

	public async doesShasumFileExistsOnDevice(): Promise<boolean> {
			let lsResult = this.adb.executeShellCommand(["ls", this.hashFileDevicePath]).wait();
			return !!(lsResult && lsResult.trim() === this.hashFileDevicePath);
	}

	public async getShasumsFromDevice(): Promise<IStringDictionary> {
			let hashFileLocalPath = this.downloadHashFileFromDevice().wait();

			if (this.$fs.exists(hashFileLocalPath)) {
				return this.$fs.readJson(hashFileLocalPath);
			}

			return null;
	}

	public async uploadHashFileToDevice(data: IStringDictionary|Mobile.ILocalToDevicePathData[]): Promise<void> {
			let shasums: IStringDictionary = {};
			if (_.isArray(data)) {
				(<Mobile.ILocalToDevicePathData[]>data).forEach(localToDevicePathData => {
					let localPath = localToDevicePathData.getLocalPath();
					let stats = this.$fs.getFsStats(localPath);
					if (stats.isFile()) {
						let fileShasum = this.$fs.getFileShasum(localPath).wait();
						shasums[localPath] = fileShasum;
					}
				});
			} else {
				shasums = <IStringDictionary>data;
			}

			this.$fs.writeJson(this.hashFileLocalPath, shasums);
			this.adb.executeCommand(["push", this.hashFileLocalPath, this.hashFileDevicePath]).wait();
	}

	public async updateHashes(localToDevicePaths: Mobile.ILocalToDevicePathData[]): Promise<boolean> {
			let oldShasums = this.getShasumsFromDevice().wait();
			if (oldShasums) {
				_.each(localToDevicePaths, ldp => {
					let localPath = ldp.getLocalPath();
					if (this.$fs.getFsStats(localPath).isFile()) {
						oldShasums[localPath] = this.$fs.getFileShasum(localPath).wait();
					}
				});
				this.uploadHashFileToDevice(oldShasums).wait();
				return true;
			}

			return false;
	}

	public async removeHashes(localToDevicePaths: Mobile.ILocalToDevicePathData[]): Promise<boolean> {
			let oldShasums = this.getShasumsFromDevice().wait();
			if (oldShasums) {
				let fileToShasumDictionary = <IStringDictionary>(_.omit(oldShasums, localToDevicePaths.map(ldp => ldp.getLocalPath())));
				this.uploadHashFileToDevice(fileToShasumDictionary).wait();
				return true;
			}

			return false;
	}

	private get hashFileLocalPath(): string {
		if (!this._hashFileLocalPath) {
			this._hashFileLocalPath = path.join(this.tempDir, AndroidDeviceHashService.HASH_FILE_NAME);
		}

		return this._hashFileLocalPath;
	}

	private get tempDir(): string {
		if (!this._tempDir) {
			temp.track();
			this._tempDir = temp.mkdirSync(`android-device-hash-service-${this.appIdentifier}`);
		}

		return this._tempDir;
	}

	private async downloadHashFileFromDevice(): Promise<string> {
			if (!this.$fs.exists(this.hashFileLocalPath)) {
				this.adb.executeCommand(["pull", this.hashFileDevicePath, this.tempDir]).wait();
			}
			return this.hashFileLocalPath;
	}
}
