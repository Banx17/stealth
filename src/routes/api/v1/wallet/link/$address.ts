import { createFileRoute } from "@tanstack/react-router";

import { requireActor } from "@/server/api/actor";
import { getApiContext } from "@/server/api/context";
import { stellarAddressSchema } from "@/server/api/domain";
import { unlinkExternalWallet } from "@/server/api/wallet-link-service";
import { apiSuccess, handleApiRequest } from "@/server/api/response";

export const Route = createFileRoute("/api/v1/wallet/link/$address")({
  server: {
    handlers: {
      DELETE: ({ request, params }) =>
        handleApiRequest(request, async () => {
          const owner = requireActor(request);
          const address = stellarAddressSchema.parse(params.address);
          const repo = getApiContext().repository;
          await unlinkExternalWallet(repo, owner, address);
          return apiSuccess(request, { unlinked: true });
        }),
    },
  },
});
