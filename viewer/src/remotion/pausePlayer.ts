export type PausablePlayer = {
  isPlaying(): boolean;
  pause(): void;
};

export function keepPlayerPaused(player: PausablePlayer): void {
  if (player.isPlaying()) player.pause();
}
