"""Render the existing layered-frame logo in Open Record Studio's zinc/blue theme."""
from pathlib import Path
from PIL import Image, ImageDraw


def generate_icon(root):
    image = Image.new("RGBA", (1024, 1024))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((26, 34, 998, 1006), radius=220, fill="#00000030")
    draw.rounded_rectangle((30, 18, 994, 982), radius=214, fill="#09090b")
    draw.rounded_rectangle((46, 32, 978, 963), radius=202, outline="#27272a", width=3)
    draw.rounded_rectangle((156, 150, 868, 862), radius=164, fill="#3a4bf8")
    draw.rounded_rectangle((159, 153, 865, 859), radius=161, outline="#5060ff", width=3)
    for points in [
        [(283, 423), (512, 292), (741, 423), (512, 554), (283, 423)],
        [(283, 530), (512, 661), (741, 530)],
        [(283, 638), (512, 769), (741, 638)],
    ]:
        draw.line(points, fill="#f4f4f5", width=24, joint="curve")
    image.save(root / "open-record-studio.png")
    image.save(root / "open-record-studio.icns")


if __name__ == "__main__":
    generate_icon(Path(__file__).resolve().parents[1] / "desktop/assets")
