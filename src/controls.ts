export type ControlType = "KEYS" | "AI" | "DUMMY";

export class Controls {
  forward = false;
  left = false;
  right = false;
  reverse = false;
  private detach?: () => void;

  constructor(type: ControlType) {
    if (type === "KEYS") this.listen();
    if (type === "DUMMY") this.forward = true;
  }

  private listen(): void {
    const set = (key: string, on: boolean): boolean => {
      switch (key) {
        case "ArrowUp": case "w": this.forward = on; return true;
        case "ArrowDown": case "s": this.reverse = on; return true;
        case "ArrowLeft": case "a": this.left = on; return true;
        case "ArrowRight": case "d": this.right = on; return true;
      }
      return false;
    };
    const down = (e: KeyboardEvent) => { if (set(e.key, true)) e.preventDefault(); };
    const up = (e: KeyboardEvent) => { set(e.key, false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    this.detach = () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }

  dispose(): void {
    this.detach?.();
  }
}
