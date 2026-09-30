#!/usr/bin/env bash
# ============================================================
# generate_sri.sh - Genere les hashs SRI (sha384) pour un fichier
# Usage : ./generate_sri.sh <chemin_fichier_local>
# Retourne : sha384-<base64>
# ============================================================
set -eu

if [ $# -ne 1 ]; then
    echo "Usage: $0 <fichier>"
    echo ""
    echo "Exemple:"
    echo "  wget https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
    echo "  ./generate_sri.sh xlsx.full.min.js"
    echo "  # Copier la sortie dans index.html : integrity=\"sha384-...\""
    exit 1
fi

FILE="$1"

if [ ! -f "$FILE" ]; then
    echo "[ERREUR] Fichier introuvable: $FILE" >&2
    exit 2
fi

HASH=$(openssl dgst -sha384 -binary "$FILE" | openssl base64 -A)
echo "sha384-${HASH}"
echo ""
echo "Attribut HTML à coller :"
echo "  integrity=\"sha384-${HASH}\""
echo "  crossorigin=\"anonymous\""