import { json } from "@react-router/node";

export function loader() {
  return json(null, { status: 204 });
}

export default function WellKnown() {
  return null;
}
