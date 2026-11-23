export type FileCatalogProvider = "windows-search" | "spotlight" | "local";
export type FileCatalogItem = {
  path: string;
  size: number;
  modified: number;
  source: FileCatalogProvider;
};
export type FileCatalog = { items: FileCatalogItem[]; providers: FileCatalogProvider[]; truncated: boolean };
