-- AlterTable
ALTER TABLE "PokemonCardDetails" ADD COLUMN "pokemonType" TEXT;

-- CreateIndex
CREATE INDEX "PokemonCardDetails_pokemonType_idx" ON "PokemonCardDetails"("pokemonType");
