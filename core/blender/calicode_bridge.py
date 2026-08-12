"""CaliCode's Blender save bridge.

Blender loads this file with ``--python``. The final argument after ``--`` is
the GLB path CaliCode watches. Every Blender save atomically replaces that GLB
so the embedded viewer never reads a half-written export.
"""

import os
import sys

import bpy
from bpy.app.handlers import persistent


def _output_path():
    if "--" not in sys.argv:
        raise RuntimeError("CaliCode bridge requires an output path after --")
    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) != 1:
        raise RuntimeError("CaliCode bridge expected exactly one output path")
    return os.path.abspath(args[0])


OUTPUT_PATH = _output_path()


def _export_glb():
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    temporary = OUTPUT_PATH + ".calicode-tmp.glb"
    bpy.ops.export_scene.gltf(
        filepath=temporary,
        export_format="GLB",
        export_animations=True,
        export_skins=True,
        export_morph=True,
        export_yup=True,
    )
    os.replace(temporary, OUTPUT_PATH)
    print("CaliCode: exported " + OUTPUT_PATH)


@persistent
def _export_after_save(_unused):
    try:
        _export_glb()
    except Exception as error:
        print("CaliCode: GLB export failed: " + str(error), file=sys.stderr)


def _install():
    handlers = bpy.app.handlers.save_post
    for handler in list(handlers):
        if getattr(handler, "__name__", "") == _export_after_save.__name__:
            handlers.remove(handler)
    handlers.append(_export_after_save)
    _export_glb()


_install()
