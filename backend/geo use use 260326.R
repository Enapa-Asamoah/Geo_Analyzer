# ===============================

# ===============================
install.packages(c("leaflet", "sf", "dplyr", "htmlwidgets", "readxl"))

# ===============================
# LOAD LIBRARIES
# ===============================
library(leaflet)
library(sf)
library(dplyr)
library(htmlwidgets)
library(readxl)

# ===============================
# SET WORKING DIRECTORY
# ===============================
setwd("C:/Users/enapa/Documents/InterDataAnalytics/districts")

# ===============================
# LOAD SHAPEFILE
# ===============================
ghana_districts <- st_read("District_272.shp")

# Inspect data
print(ghana_districts)
summary(ghana_districts)
windows()
plot(ghana_districts)

# ===============================
# LOAD POPULATION DATA
# ===============================
real_data <- read.csv("my_dataaa.csv")

# View data
head(real_data)

# Rename columns to match shapefile
names(real_data)[1] <- "Label"
names(real_data)[2] <- "Population"

# ===============================
# MERGE DATA
# ===============================
ghana_districts_merged <- left_join(ghana_districts, real_data, by = "Label")

# Check merge
head(ghana_districts_merged)
summary(ghana_districts_merged)

# Check unmatched districts
unmatched <- anti_join(real_data, ghana_districts, by = "Label")
print(unmatched)

# ===============================
# FIX GEOMETRY + SIMPLIFY
# ===============================
ghana_districts_merged <- st_make_valid(ghana_districts_merged)

ghana_districts_simple <- st_simplify(
  ghana_districts_merged,
  dTolerance = 1000
)

# ===============================
# PREPARE DATA
# ===============================
ghana_districts_simple$Population <- as.numeric(ghana_districts_simple$Population)

# Create color palette
population_pal <- colorNumeric(
  palette = "Reds",
  domain = ghana_districts_simple$Population,
  na.color = "transparent"
)

# ===============================
# CREATE INTERACTIVE MAP
# ===============================
interactive_map <- leaflet(ghana_districts_simple) %>%
  addTiles() %>%
  addPolygons(
    fillColor = ~population_pal(Population),
    weight = 1,
    opacity = 1,
    color = "white",
    fillOpacity = 0.7,
    popup = ~paste(
      "<strong>District:</strong>", Label, "<br/>",
      "<strong>Population:</strong>", Population
    ),
    highlight = highlightOptions(
      weight = 3,
      color = "blue",
      fillOpacity = 0.7
    )
  ) %>%
  addLegend(
    position = "bottomright",
    pal = population_pal,
    values = ghana_districts_simple$Population,
    title = "Population",
    opacity = 1
  )

# ===============================
# SAVE MAP
# ===============================
saveWidget(interactive_map, "ggghana_interactive_map.html")

# ===============================
# DISPLAY MAP
# ===============================
interactive_map
