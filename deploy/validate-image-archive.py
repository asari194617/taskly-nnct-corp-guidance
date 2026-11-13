#!/usr/bin/env python3
"""Accept exactly one Docker save image for the requested guidance revision."""

import json
import re
import sys
import tarfile

REPOSITORY = "ghcr.io/asari194617/taskly-nnct-corp-guidance"
MAX_ARCHIVE_SIZE = 2 * 1024**3
MAX_MEMBERS = 10000
MAX_METADATA_SIZE = 1024**2
MAX_OCI_BLOBS = 512
OCI_BLOB = re.compile(r"blobs/sha256/[0-9a-f]{64}")
LEGACY_CONFIG = re.compile(r"[0-9a-f]{64}\.json")
LEGACY_LAYER = re.compile(r"[0-9a-f]{64}/layer\.tar")


class InvalidArchive(Exception):
    pass


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidArchive("duplicate JSON key")
        result[key] = value
    return result


def read_json(archive, member):
    if member.size > MAX_METADATA_SIZE:
        raise InvalidArchive("metadata is too large")
    source = archive.extractfile(member)
    if source is None:
        raise InvalidArchive("missing metadata")
    try:
        return json.load(source, object_pairs_hook=object_pairs)
    except (ValueError, UnicodeError) as error:
        raise InvalidArchive("invalid JSON metadata") from error


def canonical_name(member):
    name = member.name.rstrip("/") if member.isdir() else member.name
    if not name or name.startswith("/") or any(
        part in ("", ".", "..") for part in name.split("/")
    ):
        raise InvalidArchive("noncanonical archive path")
    if not (member.isfile() or member.isdir()):
        raise InvalidArchive("archive contains a link or special file")
    return name


def validate(source_path, output_path, sha):
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise InvalidArchive("invalid requested revision")
    expected_tag = f"{REPOSITORY}:{sha}"
    members = {}
    metadata = {}
    total_size = 0
    with tarfile.open(source_path, "r|gz") as archive:
        for member in archive:
            name = canonical_name(member)
            if name in members:
                raise InvalidArchive("duplicate archive path")
            members[name] = member
            if len(members) > MAX_MEMBERS:
                raise InvalidArchive("too many archive entries")
            total_size += member.size
            if total_size > MAX_ARCHIVE_SIZE:
                raise InvalidArchive("archive is too large")
            if name in ("manifest.json", "repositories") and member.isfile():
                metadata[name] = read_json(archive, member)

    manifest = metadata.get("manifest.json")
    if not isinstance(manifest, list) or len(manifest) != 1:
        raise InvalidArchive("expected one image in manifest")
    image = manifest[0]
    if not isinstance(image, dict) or set(image) != {"Config", "RepoTags", "Layers"} or image.get("RepoTags") != [expected_tag]:
        raise InvalidArchive("unexpected image tag")
    config_name = image.get("Config")
    if not isinstance(config_name, str) or not (
        LEGACY_CONFIG.fullmatch(config_name) or OCI_BLOB.fullmatch(config_name)
    ):
        raise InvalidArchive("unexpected image config path")
    if config_name not in members or not members[config_name].isfile():
        raise InvalidArchive("missing image config")
    with tarfile.open(source_path, "r:gz") as archive:
        config = read_json(archive, archive.getmember(config_name))
    if not isinstance(config, dict) or not isinstance(config.get("config"), dict):
        raise InvalidArchive("missing image config")
    labels = config["config"].get("Labels")
    if not isinstance(labels, dict) or labels.get("org.opencontainers.image.revision") != sha:
        raise InvalidArchive("image revision mismatch")
    layers = image.get("Layers")
    if not isinstance(layers, list) or not layers or len(layers) > 128:
        raise InvalidArchive("unexpected image layers")
    if any(not isinstance(layer, str) or not (
        LEGACY_LAYER.fullmatch(layer) or OCI_BLOB.fullmatch(layer)
    ) for layer in layers):
        raise InvalidArchive("unexpected layer path")
    if len(set(layers)) != len(layers):
        raise InvalidArchive("unexpected layer path")
    selected = {"manifest.json", config_name, *layers}
    allowed = selected | {"repositories"}
    if OCI_BLOB.fullmatch(config_name):
        if any(not OCI_BLOB.fullmatch(layer) for layer in layers):
            raise InvalidArchive("mixed archive formats")
        blob_names = [name for name in members if OCI_BLOB.fullmatch(name)]
        if len(blob_names) > MAX_OCI_BLOBS or "index.json" not in members or "oci-layout" not in members:
            raise InvalidArchive("invalid OCI archive")
        allowed.update(("blobs", "blobs/sha256", "index.json", "oci-layout", *blob_names))
        image_manifests = []
        with tarfile.open(source_path, "r:gz") as archive:
            for name in blob_names:
                member = members[name]
                if not member.isfile() or member.size > MAX_METADATA_SIZE:
                    continue
                source = archive.extractfile(archive.getmember(name))
                if source is None:
                    raise InvalidArchive("invalid OCI blob")
                try:
                    data = json.load(source, object_pairs_hook=object_pairs)
                except (ValueError, UnicodeError):
                    continue  # Layer contents are opaque to this validator.
                # Docker save can omit mediaType or use Docker's media type,
                # depending on the image store. Shape and references matter.
                if (isinstance(data, dict) and data.get("schemaVersion") == 2
                        and "config" in data and "layers" in data):
                    image_manifests.append(data)
        expected_config_digest = "sha256:" + config_name.rsplit("/", 1)[1]
        expected_layer_digests = ["sha256:" + layer.rsplit("/", 1)[1] for layer in layers]
        def is_target_oci_image(candidate):
            config = candidate.get("config")
            image_layers = candidate.get("layers")
            return (isinstance(config, dict) and config.get("digest") == expected_config_digest
                    and isinstance(image_layers, list)
                    and [layer.get("digest") if isinstance(layer, dict) else None for layer in image_layers] == expected_layer_digests)
        targets = [candidate for candidate in image_manifests if is_target_oci_image(candidate)]
        if len(targets) != 1:
            raise InvalidArchive("expected one OCI image")
        for candidate in image_manifests:
            if candidate is targets[0]:
                continue
            config = candidate.get("config")
            image_layers = candidate.get("layers")
            # BuildKit provenance is a non-runnable OCI attestation manifest.
            # Older engines omit artifactType/subject, so inspect its media types.
            if (not isinstance(config, dict) or config.get("mediaType") != "application/vnd.oci.empty.v1+json"
                    or not isinstance(image_layers, list)
                    or not image_layers
                    or any(not isinstance(layer, dict) or layer.get("mediaType") != "application/vnd.in-toto+json" for layer in image_layers)):
                raise InvalidArchive("archive contains an additional OCI image")
    else:
        if any(not LEGACY_LAYER.fullmatch(layer) for layer in layers):
            raise InvalidArchive("mixed archive formats")
        for layer in layers:
            directory = layer.split("/", 1)[0]
            allowed.update((directory, f"{directory}/json", f"{directory}/VERSION"))
    if any(name not in allowed for name in members):
        raise InvalidArchive("archive contains an additional image or file")
    if any(name not in members or not members[name].isfile() for name in selected):
        raise InvalidArchive("image archive is incomplete")
    if "repositories" in metadata:
        repositories = metadata["repositories"]
        if not isinstance(repositories, dict) or set(repositories) != {REPOSITORY}:
            raise InvalidArchive("unexpected legacy image tag")
        tags = repositories[REPOSITORY]
        if not isinstance(tags, dict) or set(tags) != {sha} or not isinstance(tags[sha], str):
            raise InvalidArchive("unexpected legacy image tag")

    # Rebuild the archive without legacy metadata or untrusted per-layer files.
    # docker load sees only the validated manifest, config, and layer tarballs.
    with tarfile.open(source_path, "r|gz") as archive, tarfile.open(output_path, "w") as output:
        for member in archive:
            if member.name not in selected:
                continue
            clean = tarfile.TarInfo(member.name)
            clean.size = member.size
            clean.mode = 0o644
            source = archive.extractfile(member)
            if source is None:
                raise InvalidArchive("image archive is incomplete")
            output.addfile(clean, source)


def main():
    if len(sys.argv) != 4:
        print("usage: validate-image-archive.py INPUT OUTPUT SHA", file=sys.stderr)
        return 2
    try:
        validate(*sys.argv[1:])
    except (InvalidArchive, tarfile.TarError, EOFError, OSError) as error:
        print(f"Rejected Docker archive: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
