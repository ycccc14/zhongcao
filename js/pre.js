// Runs before Leaflet. Leaflet's 3D (translate3d) positioning makes iPhone Safari draw the map above
// pages and sheets whatever their z-index; plain 2D positioning doesn't.
window.L_DISABLE_3D = true;
