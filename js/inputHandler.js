/**
 * Captures 1, 2, 3, 4 lane triggers, Spacebar play/pause, and R restart.
 */
export class InputHandler {
  constructor(onLanePress, onLaneRelease, onTogglePlay, onRestart) {
    this.keyMap = {
      Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3,
      Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3
    };
    this.lanePressed = [false, false, false, false];

    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (e.code === "Space") {
        e.preventDefault();
        onTogglePlay();
        return;
      }
      if (e.code === "KeyR") {
        e.preventDefault();
        onRestart();
        return;
      }
      const lane = this.keyMap[e.code];
      if (lane !== undefined) {
        this.lanePressed[lane] = true;
        onLanePress(lane);
      }
    });

    window.addEventListener("keyup", (e) => {
      const lane = this.keyMap[e.code];
      if (lane !== undefined) {
        this.lanePressed[lane] = false;
        onLaneRelease(lane);
      }
    });
  }
}