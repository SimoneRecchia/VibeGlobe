import { WGS84 } from '@vibeglobe/core';

const status = document.querySelector<HTMLParagraphElement>('#status');
if (status) {
  status.textContent = `Engine bootstrap pending (milestone 2). Reference ellipsoid: WGS84, a = ${WGS84.semiMajorAxisMeters} m.`;
}
