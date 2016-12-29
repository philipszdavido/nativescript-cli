import { StaticConfigBase } from "../static-config-base";
import * as path from "path";

export class ProtonStaticConfig extends StaticConfigBase {
	constructor($injector: IInjector) {
		super($injector);
	}

	public async getAdbFilePath(): Promise<string> {
			let value = super.getAdbFilePath().wait();
			return value.replace("app.asar", "app.asar.unpacked");
	}

	public get PATH_TO_BOOTSTRAP(): string {
		return path.join(__dirname, "proton-bootstrap");
	}

	public disableAnalytics = true;

	public CLIENT_NAME = "Desktop Client - Universal";
}
$injector.register("staticConfig", ProtonStaticConfig);
