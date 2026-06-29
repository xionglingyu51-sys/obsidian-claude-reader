import { App, FuzzySuggestModal, TFile } from "obsidian";

const SUPPORTED = ["md", "epub", "mobi", "azw3", "txt"];

export class FileSuggestModal extends FuzzySuggestModal<TFile> {
  private onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("搜索 markdown / EPUB / MOBI / TXT...");
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => SUPPORTED.includes(f.extension.toLowerCase()))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile) {
    this.onChoose(file);
  }
}
