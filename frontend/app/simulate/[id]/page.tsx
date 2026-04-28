import { SimulatePageClient } from "./SimulatePageClient";

export default async function SimulatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SimulatePageClient simId={id} />;
}
