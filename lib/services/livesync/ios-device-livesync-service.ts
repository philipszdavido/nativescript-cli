import * as constants from "../../constants";
import * as minimatch from "minimatch";
import * as net from "net";
import { DeviceLiveSyncServiceBase } from "./device-livesync-service-base";

let currentPageReloadId = 0;

export class IOSDeviceLiveSyncService extends DeviceLiveSyncServiceBase implements INativeScriptDeviceLiveSyncService {
	private socket: net.Socket;

	constructor(
		private $logger: ILogger,
		private $processService: IProcessService,
		protected $platformsData: IPlatformsData,
		protected device: Mobile.IiOSDevice) {
		super($platformsData, device);
	}

	private async setupSocketIfNeeded(projectData: IProjectData): Promise<boolean> {
		// TODO: persist the sockets per app in order to support LiveSync on multiple apps on the same device
		if (this.socket) {
			return true;
		}

		const appId = projectData.projectIdentifiers.ios;
		this.socket = await this.device.getLiveSyncSocket(appId);
		if (!this.socket) {
			return false;
		}

		this.attachEventHandlers();

		return true;
	}

	public async removeFiles(deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]): Promise<void> {
		await Promise.all(_.map(localToDevicePaths, localToDevicePathData => this.device.fileSystem.deleteFile(localToDevicePathData.getDevicePath(), deviceAppData.appIdentifier)));
	}

	public async refreshApplication(projectData: IProjectData, liveSyncInfo: ILiveSyncResultInfo): Promise<void> {
		const deviceAppData = liveSyncInfo.deviceAppData;
		const localToDevicePaths = liveSyncInfo.modifiedFilesData;
		if (liveSyncInfo.isFullSync) {
			await this.restartApplication(deviceAppData, projectData.projectName);
			return;
		}

		let scriptRelatedFiles: Mobile.ILocalToDevicePathData[] = [];
		const scriptFiles = _.filter(localToDevicePaths, localToDevicePath => _.endsWith(localToDevicePath.getDevicePath(), ".js"));
		constants.LIVESYNC_EXCLUDED_FILE_PATTERNS.forEach(pattern => scriptRelatedFiles = _.concat(scriptRelatedFiles, localToDevicePaths.filter(file => minimatch(file.getDevicePath(), pattern, { nocase: true }))));

		const otherFiles = _.difference(localToDevicePaths, _.concat(scriptFiles, scriptRelatedFiles));
		const canExecuteFastSync = this.canExecuteFastSyncForPaths(liveSyncInfo, localToDevicePaths, projectData, deviceAppData.platform);

		if (!canExecuteFastSync) {
			await this.restartApplication(deviceAppData, projectData.projectName);
			return;
		}

		if (await this.setupSocketIfNeeded(projectData)) {
			await this.reloadPage(otherFiles);
		} else {
			await this.restartApplication(deviceAppData, projectData.projectName);
		}
	}

	private async restartApplication(deviceAppData: Mobile.IDeviceAppData, projectName: string): Promise<void> {
		return this.device.applicationManager.restartApplication({ appId: deviceAppData.appIdentifier, projectName });
	}

	private async reloadPage(localToDevicePaths: Mobile.ILocalToDevicePathData[]): Promise<void> {
		if (localToDevicePaths.length) {
			const message = JSON.stringify({
				method: "Page.reload",
				params: {
					ignoreCache: false
				},
				id: ++currentPageReloadId
			});

			await this.sendMessage(message);
		}
	}

	private attachEventHandlers(): void {
		this.$processService.attachToProcessExitSignals(this, this.destroySocket);

		this.socket.on("close", (hadError: boolean) => {
			this.$logger.trace(`Socket closed, hadError is ${hadError}.`);
			this.socket = null;
		});

		this.socket.on("error", (error: any) => {
			this.$logger.trace(`Socket error received: ${error}`);
		});

		this.socket.on("data", (data: NodeBuffer | string) => {
			this.$logger.trace(`Socket sent data: ${data.toString()}`);
		});
	}

	private async sendMessage(message: string): Promise<void> {
		try {
			await new Promise<void>((resolve, reject) => {
				let isResolved = false;
				const length = Buffer.byteLength(message, "utf16le");
				const payload = Buffer.allocUnsafe(length + 4);
				payload.writeInt32BE(length, 0);
				payload.write(message, 4, length, "utf16le");

				const errorCallback = (error: Error) => {
					if (!isResolved) {
						isResolved = true;
						reject(error);
					}
				};
				this.socket.once("error", errorCallback);

				this.socket.write(payload, "utf16le", () => {
					this.socket.removeListener("error", errorCallback);

					if (!isResolved) {
						isResolved = true;
						resolve();
					}
				});
			});
		} catch (error) {
			this.$logger.trace("Error while sending message:", error);
			this.destroySocket();
		}
	}

	private destroySocket(): void {
		if (this.socket) {
			// we do not support LiveSync on multiple apps on the same device
			// in order to do that, we should cache the socket per app
			// and destroy just the current app socket when possible
			this.device.destroyAllSockets();
			this.socket = null;
		}
	}
}
