let piSdkModulePromise: Promise<any> | undefined;

export function loadPiSdkModule(): Promise<any> {
  const moduleName = '@earendil-works/pi-coding-agent';
  piSdkModulePromise ??= import(moduleName) as Promise<any>;
  return piSdkModulePromise;
}
