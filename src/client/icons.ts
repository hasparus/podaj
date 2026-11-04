import eyeOffSvg from "pixelarticons/svg/eye-off.svg?raw";
import eyeSvg from "pixelarticons/svg/eye.svg?raw";
import trashSvg from "pixelarticons/svg/trash.svg?raw";

const pathData = (svg: string): readonly string[] => {
  const found = [...svg.matchAll(/d="(?<d>[^"]+)"/gu)]
    .map((match) => match.groups?.d)
    .filter((d): d is string => d !== undefined && d.length > 0);
  if (found.length === 0) {
    throw new Error("pixelarticons svg has no path");
  }
  return found;
};

export const eyePaths = pathData(eyeSvg);
export const eyeOffPaths = pathData(eyeOffSvg);
export const trashPaths = pathData(trashSvg);
