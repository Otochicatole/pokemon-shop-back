-- CreateIndex
CREATE INDEX "Product_status_priceMinor_idx" ON "Product"("status", "priceMinor");

-- CreateIndex
CREATE INDEX "Product_status_publishedAt_idx" ON "Product"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "PokemonCardDetails_setCode_idx" ON "PokemonCardDetails"("setCode");

-- CreateIndex
CREATE INDEX "PokemonCardDetails_condition_idx" ON "PokemonCardDetails"("condition");

-- CreateIndex
CREATE INDEX "PokemonCardDetails_language_idx" ON "PokemonCardDetails"("language");

-- CreateIndex
CREATE INDEX "PokemonCardDetails_finish_idx" ON "PokemonCardDetails"("finish");

-- CreateIndex
CREATE INDEX "PokemonCardDetails_edition_idx" ON "PokemonCardDetails"("edition");

-- CreateIndex
CREATE INDEX "PokemonCardDetails_gradingCompany_idx" ON "PokemonCardDetails"("gradingCompany");
