export interface BuildVersion {
  version: string;
  tag: string;
  commit: string;
  date: string;
  dirty: boolean;
}
export function buildVersion(): BuildVersion;
